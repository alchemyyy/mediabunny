/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Bitstream } from '../../shared/bitstream';
import {
	AvcNalUnitType,
	AvcSpsInfo,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	HevcSpsInfo,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
	parseAvcSps,
	parseHevcSps,
	removeEmulationPreventionBytes,
} from '../codec-data';
import { readExpGolomb, readSignedExpGolomb } from '../misc';

// References: Rec. ITU-T H.264 8.2.1 and 7.3.3, Rec. ITU-T H.265 8.3.1 and 7.3.6.1, and FFmpeg's h264_parser.c and
// h264_parse.c, whose order count derivation this follows

/**
 * A picture's place in output order: pictures sort by epoch, which each order count reset begins, then by their
 * order count.
 */
export type PictureOrder = {
	epoch: number;
	orderCount: number;
};

/**
 * What reading a packet gave: its picture's order, 'truncated' when its bytes end before the picture's slice header
 * does, or null when it holds no picture that can be placed.
 */
export type PictureOrderResult = PictureOrder | 'truncated' | null;

/** Reads the output order of the pictures of a stream whose packets come in decode order. */
export interface PictureOrderReader {
	/** Starts a new order count at the next picture, as decoding from a random access point does. */
	reset(): void;
	/** Reads the picture in a packet, the one after the previous packet read in decode order. */
	readPicture(data: Uint8Array, isComplete: boolean): PictureOrderResult;
	/** The output delay in pictures that the last picture's sequence declares, or null when it declares none. */
	getDeclaredReorderDepth(): number | null;
	/** Whether the last picture's sequence outputs every picture in decode order. */
	outputsInDecodeOrder(): boolean;
}

// The slice header bytes read first; a header that runs past them is read again from four times as many
const FIRST_SLICE_HEADER_BYTE_COUNT = 64;

type NalUnit = {
	bytes: Uint8Array;
	isTruncated: boolean;
};

/** Reads a slice header from a growing prefix of its NAL unit, so a large slice is not unescaped whole. */
const readSliceHeader = <T>(nalUnit: NalUnit, read: (bitstream: Bitstream) => T): T | 'truncated' | null => {
	let byteCount = FIRST_SLICE_HEADER_BYTE_COUNT;
	while (true) {
		const prefix = nalUnit.bytes.subarray(0, byteCount);
		const rbsp = removeEmulationPreventionBytes(prefix);
		const bitstream = new Bitstream(rbsp);
		let result: T;
		try {
			result = read(bitstream);
		} catch {
			return null;
		}

		if (bitstream.pos <= 8 * rbsp.length) {
			return result;
		}
		if (prefix.length === nalUnit.bytes.length) {
			return nalUnit.isTruncated ? 'truncated' : null;
		}
		byteCount *= 4;
	}
};

abstract class NalPictureOrderReader implements PictureOrderReader {
	/** The NAL unit length size of length-prefixed packets, or null for Annex B. */
	protected lengthSize: 1 | 2 | 3 | 4 | null = null;
	protected epoch = 0;
	protected startsCount = true;

	abstract getDeclaredReorderDepth(): number | null;
	abstract outputsInDecodeOrder(): boolean;

	/**
	 * Reads one NAL unit: a picture's order, or 'truncated' or null, ends the packet; undefined goes on to the next
	 * NAL unit.
	 */
	protected abstract readNalUnit(nalUnit: NalUnit): PictureOrderResult | undefined;

	reset() {
		this.startsCount = true;
		this.epoch++;
	}

	/** Reads the parameter sets of extradata in Annex B. */
	protected readAnnexBParameterSets(extraData: Uint8Array) {
		for (const location of iterateNalUnitsInAnnexB(extraData)) {
			const bytes = extraData.subarray(location.offset, location.offset + location.length);
			this.readNalUnit({ bytes, isTruncated: false });
		}
	}

	readPicture(data: Uint8Array, isComplete: boolean): PictureOrderResult {
		const locations = this.lengthSize === null
			? iterateNalUnitsInAnnexB(data)
			: iterateNalUnitsInLengthPrefixed(data, this.lengthSize);

		for (const location of locations) {
			const end = location.offset + location.length;
			const nalUnit = {
				bytes: data.subarray(location.offset, Math.min(end, data.length)),
				// Annex B NAL units run to the next start code, so the last one may go on past a prefix
				isTruncated: !isComplete && (end >= data.length),
			};
			if (nalUnit.bytes.length === 0) {
				continue;
			}

			const result = this.readNalUnit(nalUnit);
			if (result !== undefined) {
				return result;
			}
		}

		return isComplete ? null : 'truncated';
	}
}

type AvcPictureParameterSet = {
	spsId: number;
	bottomFieldPicOrderInFramePresentFlag: number;
	numRefIdxDefaultActive: [number, number];
	weightedPredFlag: number;
	weightedBipredIdc: number;
	redundantPicCntPresentFlag: number;
};

type AvcSliceHeader = {
	sps: AvcSpsInfo;
	frameNum: number;
	fieldPicFlag: number;
	bottomFieldFlag: number;
	picOrderCntLsb: number;
	deltaPicOrderCntBottom: number;
	deltaPicOrderCnt: [number, number];
	hasMemoryManagementReset: boolean;
};

const AVC_SLICE_TYPE_P = 0;
const AVC_SLICE_TYPE_B = 1;
const AVC_SLICE_TYPE_I = 2;
const AVC_MMCO_END = 0;
const AVC_MMCO_RESET = 5;
const AVC_MAX_MMCO_COUNT = 66;

const readAvcPictureParameterSet = (bitstream: Bitstream): [number, AvcPictureParameterSet] => {
	bitstream.skipBits(8); // NAL header
	const ppsId = readExpGolomb(bitstream);
	const spsId = readExpGolomb(bitstream);
	bitstream.skipBits(1); // entropy_coding_mode_flag
	const bottomFieldPicOrderInFramePresentFlag = bitstream.readBits(1);

	const numSliceGroupsMinus1 = readExpGolomb(bitstream);
	if (numSliceGroupsMinus1 > 0) {
		skipAvcSliceGroups(bitstream, numSliceGroupsMinus1);
	}

	const numRefIdxL0DefaultActive = readExpGolomb(bitstream) + 1;
	const numRefIdxL1DefaultActive = readExpGolomb(bitstream) + 1;
	const weightedPredFlag = bitstream.readBits(1);
	const weightedBipredIdc = bitstream.readBits(2);
	readSignedExpGolomb(bitstream); // pic_init_qp_minus26
	readSignedExpGolomb(bitstream); // pic_init_qs_minus26
	readSignedExpGolomb(bitstream); // chroma_qp_index_offset
	bitstream.skipBits(1); // deblocking_filter_control_present_flag
	bitstream.skipBits(1); // constrained_intra_pred_flag
	const redundantPicCntPresentFlag = bitstream.readBits(1);

	return [ppsId, {
		spsId,
		bottomFieldPicOrderInFramePresentFlag,
		numRefIdxDefaultActive: [numRefIdxL0DefaultActive, numRefIdxL1DefaultActive],
		weightedPredFlag,
		weightedBipredIdc,
		redundantPicCntPresentFlag,
	}];
};

const skipAvcSliceGroups = (bitstream: Bitstream, numSliceGroupsMinus1: number) => {
	const sliceGroupMapType = readExpGolomb(bitstream);
	if (sliceGroupMapType === 0) {
		for (let i = 0; i <= numSliceGroupsMinus1; i++) {
			readExpGolomb(bitstream); // run_length_minus1[i]
		}
	} else if (sliceGroupMapType === 2) {
		for (let i = 0; i < numSliceGroupsMinus1; i++) {
			readExpGolomb(bitstream); // top_left[i]
			readExpGolomb(bitstream); // bottom_right[i]
		}
	} else if (sliceGroupMapType >= 3 && sliceGroupMapType <= 5) {
		bitstream.skipBits(1); // slice_group_change_direction_flag
		readExpGolomb(bitstream); // slice_group_change_rate_minus1
	} else if (sliceGroupMapType === 6) {
		const picSizeInMapUnits = readExpGolomb(bitstream) + 1;
		const idBitCount = Math.ceil(Math.log2(numSliceGroupsMinus1 + 1));
		bitstream.skipBits(picSizeInMapUnits * idBitCount); // slice_group_id[i]
	}
};

/** Skips a slice header's pred_weight_table. */
const skipAvcPredWeightTable = (
	bitstream: Bitstream,
	sps: AvcSpsInfo,
	refIdxActive: [number, number],
	listCount: number,
) => {
	const chromaArrayType = sps.separateColourPlaneFlag ? 0 : sps.chromaFormatIdc;
	readExpGolomb(bitstream); // luma_log2_weight_denom
	if (chromaArrayType !== 0) {
		readExpGolomb(bitstream); // chroma_log2_weight_denom
	}

	for (let list = 0; list < listCount; list++) {
		for (let i = 0; i < refIdxActive[list]!; i++) {
			if (bitstream.readBits(1)) { // luma_weight_flag
				readSignedExpGolomb(bitstream); // luma_weight
				readSignedExpGolomb(bitstream); // luma_offset
			}
			if (chromaArrayType !== 0 && bitstream.readBits(1)) { // chroma_weight_flag
				for (let j = 0; j < 4; j++) {
					readSignedExpGolomb(bitstream); // chroma_weight and chroma_offset
				}
			}
		}
	}
};

/**
 * Reads what follows a reference non-IDR slice's order count fields up to its dec_ref_pic_marking, and returns
 * whether that holds memory_management_control_operation 5, which resets the order count.
 */
const readAvcMemoryManagementReset = (
	bitstream: Bitstream,
	sps: AvcSpsInfo,
	pps: AvcPictureParameterSet,
	sliceType: number,
	isFieldPicture: boolean,
) => {
	if (pps.redundantPicCntPresentFlag) {
		readExpGolomb(bitstream); // redundant_pic_cnt
	}
	if (sliceType === AVC_SLICE_TYPE_B) {
		bitstream.skipBits(1); // direct_spatial_mv_pred_flag
	}

	const refIdxActive: [number, number] = [...pps.numRefIdxDefaultActive];
	let listCount = 0;
	if (sliceType !== AVC_SLICE_TYPE_I) {
		listCount = sliceType === AVC_SLICE_TYPE_B ? 2 : 1;
		if (bitstream.readBits(1)) { // num_ref_idx_active_override_flag
			refIdxActive[0] = readExpGolomb(bitstream) + 1;
			if (sliceType === AVC_SLICE_TYPE_B) {
				refIdxActive[1] = readExpGolomb(bitstream) + 1;
			}
		}
		const maxRefIdxActive = isFieldPicture ? 32 : 16;
		if (refIdxActive[0] > maxRefIdxActive || refIdxActive[1] > maxRefIdxActive) {
			throw new Error('Invalid reference count.');
		}

		for (let list = 0; list < listCount; list++) {
			if (bitstream.readBits(1)) { // ref_pic_list_modification_flag
				skipAvcRefPicListModification(bitstream);
			}
		}
	}

	if (
		(pps.weightedPredFlag && sliceType === AVC_SLICE_TYPE_P)
		|| (pps.weightedBipredIdc === 1 && sliceType === AVC_SLICE_TYPE_B)
	) {
		skipAvcPredWeightTable(bitstream, sps, refIdxActive, listCount);
	}

	if (!bitstream.readBits(1)) { // adaptive_ref_pic_marking_mode_flag
		return false;
	}

	for (let i = 0; i < AVC_MAX_MMCO_COUNT; i++) {
		const operation = readExpGolomb(bitstream);
		if (operation === AVC_MMCO_END) {
			return false;
		} else if (operation === AVC_MMCO_RESET) {
			return true;
		} else if (operation > 6) {
			throw new Error('Invalid memory management control operation.');
		}

		if (operation === 1 || operation === 3) {
			readExpGolomb(bitstream); // difference_of_pic_nums_minus1
		}
		if (operation === 2 || operation === 3 || operation === 4 || operation === 6) {
			readExpGolomb(bitstream); // long_term_pic_num, long_term_frame_idx, or max_long_term_frame_idx_plus1
		}
	}

	return false;
};

const skipAvcRefPicListModification = (bitstream: Bitstream) => {
	for (let i = 0; i <= 32; i++) {
		const modificationOfPicNumsIdc = readExpGolomb(bitstream);
		if (modificationOfPicNumsIdc === 3) {
			return;
		} else if (modificationOfPicNumsIdc > 3) {
			throw new Error('Invalid modification_of_pic_nums_idc.');
		}
		readExpGolomb(bitstream); // abs_diff_pic_num_minus1 or long_term_pic_num
	}
	throw new Error('Too many reference picture list modifications.');
};

/** Reads the output order of H.264 pictures from their slice headers, as FFmpeg's H.264 parser does. */
export class AvcPictureOrderReader extends NalPictureOrderReader {
	private sequenceParameterSets = new Map<number, AvcSpsInfo>();
	private pictureParameterSets = new Map<number, AvcPictureParameterSet>();
	private activeSps: AvcSpsInfo | null = null;

	private prevPicOrderCntMsb = 0;
	private prevPicOrderCntLsb = 0;
	private prevFrameNumOffset = 0;
	private prevFrameNum = 0;

	/** Takes the stream's extradata: an AVC decoder configuration record, or parameter sets in Annex B. */
	constructor(extraData: Uint8Array | null) {
		super();

		if (extraData && extraData[0] === 1) {
			const record = deserializeAvcDecoderConfigurationRecord(extraData);
			if (record) {
				this.lengthSize = (record.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;
				for (const bytes of [...record.sequenceParameterSets, ...record.pictureParameterSets]) {
					this.readNalUnit({ bytes, isTruncated: false });
				}
			}
		} else if (extraData) {
			this.readAnnexBParameterSets(extraData);
		}
	}

	getDeclaredReorderDepth() {
		const sps = this.activeSps;
		return sps?.bitstreamRestrictionFlag ? sps.numReorderFrames : null;
	}

	outputsInDecodeOrder() {
		return this.activeSps?.picOrderCntType === 2 || this.getDeclaredReorderDepth() === 0;
	}

	protected readNalUnit(nalUnit: NalUnit): PictureOrderResult | undefined {
		const header = nalUnit.bytes[0]!;
		const nalUnitType = header & 0x1f;
		const nalRefIdc = (header >> 5) & 0b11;

		if (nalUnitType === AvcNalUnitType.SPS || nalUnitType === AvcNalUnitType.PPS) {
			if (nalUnit.isTruncated) {
				return 'truncated';
			}
			this.readParameterSet(nalUnitType, nalUnit.bytes);
			return undefined;
		}
		if (nalUnitType !== AvcNalUnitType.IDR && nalUnitType !== AvcNalUnitType.NON_IDR_SLICE) {
			return undefined;
		}

		const isIdr = nalUnitType === AvcNalUnitType.IDR;
		const sliceHeader = readSliceHeader(nalUnit, bitstream => this.readSliceHeader(bitstream, isIdr, nalRefIdc));
		if (sliceHeader === 'truncated' || sliceHeader === null) {
			return sliceHeader;
		}

		this.activeSps = sliceHeader.sps;
		return this.derivePictureOrder(sliceHeader, isIdr, nalRefIdc);
	}

	private readParameterSet(nalUnitType: number, bytes: Uint8Array) {
		if (nalUnitType === AvcNalUnitType.SPS) {
			const sps = parseAvcSps(bytes);
			if (sps) {
				this.sequenceParameterSets.set(sps.seqParameterSetId, sps);
			}
			return;
		}

		try {
			const [ppsId, pps] = readAvcPictureParameterSet(new Bitstream(removeEmulationPreventionBytes(bytes)));
			this.pictureParameterSets.set(ppsId, pps);
		} catch {
			// A picture parameter set that cannot be read leaves its pictures unplaced
		}
	}

	private readSliceHeader(bitstream: Bitstream, isIdr: boolean, nalRefIdc: number): AvcSliceHeader | null {
		bitstream.skipBits(8); // NAL header
		readExpGolomb(bitstream); // first_mb_in_slice
		const sliceType = readExpGolomb(bitstream) % 5;
		const pps = this.pictureParameterSets.get(readExpGolomb(bitstream));
		const sps = pps && this.sequenceParameterSets.get(pps.spsId);
		if (!pps || !sps) {
			return null;
		}

		if (sps.separateColourPlaneFlag) {
			bitstream.skipBits(2); // colour_plane_id
		}
		const frameNum = bitstream.readBits(sps.log2MaxFrameNumMinus4 + 4);
		let fieldPicFlag = 0;
		let bottomFieldFlag = 0;
		if (!sps.frameMbsOnlyFlag) {
			fieldPicFlag = bitstream.readBits(1);
			if (fieldPicFlag) {
				bottomFieldFlag = bitstream.readBits(1);
			}
		}
		if (isIdr) {
			readExpGolomb(bitstream); // idr_pic_id
		}

		let picOrderCntLsb = 0;
		let deltaPicOrderCntBottom = 0;
		const deltaPicOrderCnt: [number, number] = [0, 0];
		const readsBottomDelta = pps.bottomFieldPicOrderInFramePresentFlag && !fieldPicFlag;
		if (sps.picOrderCntType === 0) {
			picOrderCntLsb = bitstream.readBits(sps.log2MaxPicOrderCntLsbMinus4 + 4);
			if (readsBottomDelta) {
				deltaPicOrderCntBottom = readSignedExpGolomb(bitstream);
			}
		} else if (sps.picOrderCntType === 1 && !sps.deltaPicOrderAlwaysZeroFlag) {
			deltaPicOrderCnt[0] = readSignedExpGolomb(bitstream);
			if (readsBottomDelta) {
				deltaPicOrderCnt[1] = readSignedExpGolomb(bitstream);
			}
		}

		// The SP and SI slice types read as P and I
		let sliceTypeWithoutSwitching = sliceType;
		if (sliceType === 3) {
			sliceTypeWithoutSwitching = AVC_SLICE_TYPE_P;
		} else if (sliceType === 4) {
			sliceTypeWithoutSwitching = AVC_SLICE_TYPE_I;
		}
		const hasMemoryManagementReset = nalRefIdc !== 0 && !isIdr
			&& readAvcMemoryManagementReset(bitstream, sps, pps, sliceTypeWithoutSwitching, fieldPicFlag === 1);

		return {
			sps,
			frameNum,
			fieldPicFlag,
			bottomFieldFlag,
			picOrderCntLsb,
			deltaPicOrderCntBottom,
			deltaPicOrderCnt,
			hasMemoryManagementReset,
		};
	}

	private derivePictureOrder(slice: AvcSliceHeader, isIdr: boolean, nalRefIdc: number): PictureOrder {
		const { sps } = slice;

		if (isIdr) {
			this.epoch++;
			this.prevPicOrderCntMsb = 0;
			this.prevPicOrderCntLsb = 0;
			this.prevFrameNumOffset = 0;
			this.prevFrameNum = 0;
		} else if (this.startsCount) {
			// Without the pictures before it, a picture starts the count it would continue
			this.prevPicOrderCntMsb = 0;
			this.prevPicOrderCntLsb = slice.picOrderCntLsb;
			this.prevFrameNumOffset = 0;
			this.prevFrameNum = slice.frameNum;
		}
		this.startsCount = false;

		let frameNumOffset = this.prevFrameNumOffset;
		if (slice.frameNum < this.prevFrameNum) {
			frameNumOffset += 2 ** (sps.log2MaxFrameNumMinus4 + 4);
		}

		let picOrderCntMsb = this.prevPicOrderCntMsb;
		let fieldOrderCounts: [number, number];
		if (sps.picOrderCntType === 0) {
			const maxPicOrderCntLsb = 2 ** (sps.log2MaxPicOrderCntLsbMinus4 + 4);
			const lsb = slice.picOrderCntLsb;
			if (lsb < this.prevPicOrderCntLsb && this.prevPicOrderCntLsb - lsb >= maxPicOrderCntLsb / 2) {
				picOrderCntMsb += maxPicOrderCntLsb;
			} else if (lsb > this.prevPicOrderCntLsb && lsb - this.prevPicOrderCntLsb > maxPicOrderCntLsb / 2) {
				picOrderCntMsb -= maxPicOrderCntLsb;
			}
			const top = picOrderCntMsb + lsb;
			fieldOrderCounts = [top, slice.fieldPicFlag ? top : top + slice.deltaPicOrderCntBottom];
		} else if (sps.picOrderCntType === 1) {
			fieldOrderCounts = this.deriveType1FieldOrderCounts(slice, frameNumOffset, nalRefIdc);
		} else {
			const orderCount = 2 * (frameNumOffset + slice.frameNum) - (nalRefIdc === 0 ? 1 : 0);
			fieldOrderCounts = [orderCount, orderCount];
		}

		// A field picture has the order count of its own parity; a frame the lesser of its two fields'
		let orderCount = Math.min(...fieldOrderCounts);
		if (slice.fieldPicFlag) {
			orderCount = fieldOrderCounts[slice.bottomFieldFlag]!;
		}

		if (slice.hasMemoryManagementReset) {
			// The picture is output after every earlier one, and the count restarts from it
			this.epoch++;
			const topAfterReset = fieldOrderCounts[0] - orderCount;
			this.prevPicOrderCntMsb = 0;
			this.prevPicOrderCntLsb = slice.fieldPicFlag && slice.bottomFieldFlag ? 0 : topAfterReset;
			this.prevFrameNumOffset = 0;
			this.prevFrameNum = 0;
			return { epoch: this.epoch, orderCount: 0 };
		}

		this.prevFrameNumOffset = frameNumOffset;
		this.prevFrameNum = slice.frameNum;
		if (nalRefIdc !== 0) {
			this.prevPicOrderCntMsb = picOrderCntMsb;
			this.prevPicOrderCntLsb = slice.picOrderCntLsb;
		}

		return { epoch: this.epoch, orderCount };
	}

	private deriveType1FieldOrderCounts(slice: AvcSliceHeader, frameNumOffset: number, nalRefIdc: number) {
		const { sps } = slice;
		const cycleLength = sps.offsetForRefFrame.length;
		let absFrameNum = cycleLength !== 0 ? frameNumOffset + slice.frameNum : 0;
		if (nalRefIdc === 0 && absFrameNum > 0) {
			absFrameNum--;
		}

		let expectedOrderCount = 0;
		if (absFrameNum > 0) {
			const expectedDeltaPerCycle = sps.offsetForRefFrame.reduce((sum, offset) => sum + offset, 0);
			const cycleCount = Math.floor((absFrameNum - 1) / cycleLength);
			const frameNumInCycle = (absFrameNum - 1) % cycleLength;
			expectedOrderCount = cycleCount * expectedDeltaPerCycle;
			for (let i = 0; i <= frameNumInCycle; i++) {
				expectedOrderCount += sps.offsetForRefFrame[i]!;
			}
		}
		if (nalRefIdc === 0) {
			expectedOrderCount += sps.offsetForNonRefPic;
		}

		const top = expectedOrderCount + slice.deltaPicOrderCnt[0];
		let bottom = top + sps.offsetForTopToBottomField;
		if (!slice.fieldPicFlag) {
			bottom += slice.deltaPicOrderCnt[1];
		}

		return [top, bottom] as [number, number];
	}
}

type HevcPictureParameterSet = {
	spsId: number;
	dependentSliceSegmentsEnabledFlag: number;
	outputFlagPresentFlag: number;
	numExtraSliceHeaderBits: number;
};

const HEVC_VCL_TYPE_END = 21; // CRA_NUT
const HEVC_BLA_FIRST = 16;
const HEVC_IDR_W_RADL = 19;
const HEVC_IDR_N_LP = 20;
const HEVC_RADL_N = 6;
const HEVC_RASL_R = 9;
const HEVC_SUB_LAYER_NON_REFERENCE_END = 14;
const HEVC_SPS = 33;
const HEVC_PPS = 34;

/** Reads the output order of HEVC pictures from their slice segment headers, as FFmpeg's HEVC decoder does. */
export class HevcPictureOrderReader extends NalPictureOrderReader {
	private sequenceParameterSets = new Map<number, HevcSpsInfo>();
	private pictureParameterSets = new Map<number, HevcPictureParameterSet>();
	private activeSps: HevcSpsInfo | null = null;
	private prevTid0PicOrderCnt = 0;

	/** Takes the stream's extradata: an HEVC decoder configuration record, or parameter sets in Annex B. */
	constructor(extraData: Uint8Array | null) {
		super();

		if (extraData && extraData[0] === 1) {
			const record = deserializeHevcDecoderConfigurationRecord(extraData);
			if (record) {
				this.lengthSize = (record.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;
				for (const array of record.arrays) {
					for (const bytes of array.nalUnits) {
						this.readNalUnit({ bytes, isTruncated: false });
					}
				}
			}
		} else if (extraData) {
			this.readAnnexBParameterSets(extraData);
		}
	}

	getDeclaredReorderDepth() {
		return this.activeSps?.spsMaxNumReorderPics ?? null;
	}

	outputsInDecodeOrder() {
		return this.getDeclaredReorderDepth() === 0;
	}

	protected readNalUnit(nalUnit: NalUnit): PictureOrderResult | undefined {
		if (nalUnit.bytes.length < 2) {
			return undefined;
		}
		const nalUnitType = (nalUnit.bytes[0]! >> 1) & 0x3f;
		const temporalId = (nalUnit.bytes[1]! & 0b111) - 1;

		if (nalUnitType === HEVC_SPS || nalUnitType === HEVC_PPS) {
			if (nalUnit.isTruncated) {
				return 'truncated';
			}
			this.readParameterSet(nalUnitType, nalUnit.bytes);
			return undefined;
		}
		if (nalUnitType > HEVC_VCL_TYPE_END || (nalUnitType > HEVC_RASL_R && nalUnitType < HEVC_BLA_FIRST)) {
			return undefined;
		}

		const result = readSliceHeader(nalUnit, bitstream => this.readSliceHeader(bitstream, nalUnitType));
		if (result === 'truncated' || result === null) {
			return result;
		}

		this.activeSps = result.sps;
		return this.derivePictureOrder(nalUnitType, temporalId, result.picOrderCntLsb, result.sps);
	}

	private readParameterSet(nalUnitType: number, bytes: Uint8Array) {
		if (nalUnitType === HEVC_SPS) {
			const sps = parseHevcSps(bytes);
			if (sps) {
				this.sequenceParameterSets.set(sps.seqParameterSetId, sps);
			}
			return;
		}

		try {
			const bitstream = new Bitstream(removeEmulationPreventionBytes(bytes));
			bitstream.skipBits(16); // NAL header
			const ppsId = readExpGolomb(bitstream);
			this.pictureParameterSets.set(ppsId, {
				spsId: readExpGolomb(bitstream),
				dependentSliceSegmentsEnabledFlag: bitstream.readBits(1),
				outputFlagPresentFlag: bitstream.readBits(1),
				numExtraSliceHeaderBits: bitstream.readBits(3),
			});
		} catch {
			// A picture parameter set that cannot be read leaves its pictures unplaced
		}
	}

	private readSliceHeader(bitstream: Bitstream, nalUnitType: number) {
		bitstream.skipBits(16); // NAL header
		if (!bitstream.readBits(1)) { // first_slice_segment_in_pic_flag
			throw new Error('A picture starts with a slice segment that is not its first.');
		}
		if (nalUnitType >= HEVC_BLA_FIRST) {
			bitstream.skipBits(1); // no_output_of_prior_pics_flag
		}

		const pps = this.pictureParameterSets.get(readExpGolomb(bitstream));
		const sps = pps && this.sequenceParameterSets.get(pps.spsId);
		if (!pps || !sps) {
			return null;
		}

		bitstream.skipBits(pps.numExtraSliceHeaderBits); // slice_reserved_flag[i]
		readExpGolomb(bitstream); // slice_type
		if (pps.outputFlagPresentFlag) {
			bitstream.skipBits(1); // pic_output_flag
		}
		if (sps.separateColourPlaneFlag) {
			bitstream.skipBits(2); // colour_plane_id
		}

		const isIdr = nalUnitType === HEVC_IDR_W_RADL || nalUnitType === HEVC_IDR_N_LP;
		const picOrderCntLsb = isIdr ? 0 : bitstream.readBits(sps.log2MaxPicOrderCntLsbMinus4 + 4);

		return { sps, picOrderCntLsb };
	}

	private derivePictureOrder(nalUnitType: number, temporalId: number, lsb: number, sps: HevcSpsInfo): PictureOrder {
		const isIdrOrBla = nalUnitType >= HEVC_BLA_FIRST && nalUnitType <= HEVC_IDR_N_LP;

		// An IDR or BLA picture, or the first picture read after a reset, starts the count
		let picOrderCntMsb = 0;
		if (isIdrOrBla) {
			this.epoch++;
		} else if (!this.startsCount) {
			const maxPicOrderCntLsb = 2 ** (sps.log2MaxPicOrderCntLsbMinus4 + 4);
			const prevLsb = this.prevTid0PicOrderCnt & (maxPicOrderCntLsb - 1);
			const prevMsb = this.prevTid0PicOrderCnt - prevLsb;
			picOrderCntMsb = prevMsb;
			if (lsb < prevLsb && prevLsb - lsb >= maxPicOrderCntLsb / 2) {
				picOrderCntMsb += maxPicOrderCntLsb;
			} else if (lsb > prevLsb && lsb - prevLsb > maxPicOrderCntLsb / 2) {
				picOrderCntMsb -= maxPicOrderCntLsb;
			}
		}
		this.startsCount = false;

		const orderCount = picOrderCntMsb + lsb;
		const isLeadingPicture = nalUnitType >= HEVC_RADL_N && nalUnitType <= HEVC_RASL_R;
		const isSubLayerNonReference = nalUnitType <= HEVC_SUB_LAYER_NON_REFERENCE_END && nalUnitType % 2 === 0;
		if (temporalId === 0 && !isLeadingPicture && !isSubLayerNonReference) {
			this.prevTid0PicOrderCnt = orderCount;
		}

		return { epoch: this.epoch, orderCount };
	}
}
