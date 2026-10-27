/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { EncodedPacket, PacketRetrievalOptions, PacketRetrievalResult, PLACEHOLDER_DATA } from '../packet';
import { Input } from '../input';
import {
	InputVideoTrackBacking,
	InputAudioTrackBacking,
	InputTrackBacking,
} from '../input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import {
	VideoCodec,
	AudioCodec,
	MediaCodec,
	extractAudioCodecString,
	extractColorSpace,
	extractVideoCodecString,
} from '../codec';
import {
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
	HevcNalUnitType,
	extractNalUnitTypeForHevc,
	iterateNalUnitsInAnnexB,
	parseHevcSps,
} from '../codec-data';
import { Reader, readBytes, readU32Le } from '../reader';
import { TrackType } from '../output';
import {
	textDecoder,
	binarySearchLessOrEqual,
	IDENTITY_MATRIX,
	MaybeRelevantPromise,
	ResultValue,
	TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import {
	AVIMainHeader, AVIStreamHeader, AVIBitmapInfoHeader, AVIWaveFormatEx, AVIIndexEntry,
	parseMainHeader, parseStreamHeader, parseBitmapInfoHeader, parseWaveFormatEx, parseIndexEntry,
	aviVideoFourccToCodec, aviWaveFormatToCodec, getWaveFormatCodecTag, parseStreamChunkId, AVIIF_KEYFRAME,
} from './avi-misc';
import { AvcPictureOrderReader, HevcPictureOrderReader, PictureOrderReader } from './avi-picture-order';
import { AviPresentationTimes } from './avi-presentation-times';

type StreamInfo = {
	header: AVIStreamHeader;
	format: AVIBitmapInfoHeader | AVIWaveFormatEx;
	backing?: AviVideoTrackBacking | AviAudioTrackBacking;
	/** The stream's non-empty chunks, in file order, which is decode order. */
	packets: PacketInfo[];
	keyPacketIndices: number[];
	/** The stream's number, which its chunk IDs carry. */
	index: number;
	/** The samples the chunks seen so far take, in units of scale / rate seconds. */
	sampleCount: number;
	/** The codec read from the stream's first chunk, for a stream whose header names none. */
	identifiedCodec?: VideoCodec;
};

type PacketInfo = {
	entry: AVIIndexEntry;
	timestamp: number;
	duration: number;
	isKey: boolean;
};

type ChunkInfo = {
	fourcc: string;
	size: number;
	position: number;
};

// The compression of uncompressed RGB, BI_RGB, which FFmpeg's AVI muxer also writes for a codec it has no tag for
const UNTAGGED_COMPRESSION = '\0\0\0\0';
// The bytes of a stream's first chunk that must hold the parameter sets that identify its codec
const IDENTIFYING_PREFIX_BYTE_COUNT = 4096;

/**
 * Returns whether a chunk starts with the HEVC parameter sets an Annex B key frame carries: a start code, then a VPS,
 * an SPS that parses, and a PPS. Uncompressed pictures hold no such structure.
 */
const startsWithHevcParameterSets = (data: Uint8Array) => {
	const startsWithStartCode = data[0] === 0 && data[1] === 0
		&& (data[2] === 1 || (data[2] === 0 && data[3] === 1));
	if (!startsWithStartCode) {
		return false;
	}

	const found = new Set<number>();
	for (const location of iterateNalUnitsInAnnexB(data)) {
		const nalUnit = data.subarray(location.offset, location.offset + location.length);
		const type = extractNalUnitTypeForHevc(nalUnit[0] ?? 0);
		if (type === HevcNalUnitType.SPS_NUT && !parseHevcSps(nalUnit)) {
			return false;
		}
		found.add(type);
	}

	return found.has(HevcNalUnitType.VPS_NUT) && found.has(HevcNalUnitType.SPS_NUT)
		&& found.has(HevcNalUnitType.PPS_NUT);
};

const VIDEO_CHUNK_TYPES = ['db', 'dc'];
const AUDIO_CHUNK_TYPES = ['wb'];

// Sample sizes that, with an equal block alignment, mark one AAC or MP3 frame per chunk rather than bytes, as FFmpeg
// reads them
const AAC_FRAME_SAMPLE_SIZES = [1024, 4096];
const MP3_FRAME_SAMPLE_SIZE = 1152;
const WAVE_FORMAT_MPEG_LAYER_3 = 0x0055;
const WAVE_FORMAT_AAC_TAGS = [0x00ff, 0x1600, 0x1601];

/**
 * Returns the sample size by which a stream's chunks are timed: by bytes when it is nonzero, else per chunk or block.
 * Follows FFmpeg's reading: video is always timed per chunk, an audio sample size that disagrees with the block
 * alignment takes the block alignment, and variable-bitrate AAC and MP3, which declare their frame size as both, are
 * timed per frame.
 */
const getTimingSampleSize = (header: AVIStreamHeader, format: AVIBitmapInfoHeader | AVIWaveFormatEx) => {
	if (header.fccType !== 'auds' || !('formatTag' in format)) {
		return 0;
	}

	let sampleSize = header.sampleSize;
	if (sampleSize !== 0 && format.blockAlign !== 0 && sampleSize !== format.blockAlign) {
		sampleSize = format.blockAlign;
	}

	const codecTag = getWaveFormatCodecTag(format);
	const isFramedAac = codecTag !== null && WAVE_FORMAT_AAC_TAGS.includes(codecTag)
		&& AAC_FRAME_SAMPLE_SIZES.includes(sampleSize)
		&& format.blockAlign === sampleSize;
	const isFramedMp3 = codecTag === WAVE_FORMAT_MPEG_LAYER_3
		&& sampleSize === MP3_FRAME_SAMPLE_SIZE
		&& format.blockAlign === sampleSize;
	if (isFramedAac || isFramedMp3) {
		return 0;
	}

	return sampleSize;
};

const FLAC_STREAMINFO_SIZE = 34;
const FLAC_STREAMINFO_BLOCK_HEADER = [0x80, 0x00, 0x00, FLAC_STREAMINFO_SIZE]; // Last block, STREAMINFO, 34 bytes

/**
 * Returns the decoder description a codec's strf extradata gives, as FFmpeg's muxer stores it: AAC's
 * AudioSpecificConfig, FLAC's STREAMINFO, made into the 'fLaC' stream header WebCodecs expects, and Vorbis's three
 * headers in Xiph lacing, which is WebCodecs's form already.
 */
const getAudioCodecDescription = (codec: AudioCodec, extraData: Uint8Array | undefined): Uint8Array | null => {
	if (!extraData) {
		return null;
	}

	switch (codec) {
		case 'aac':
			return extraData;
		case 'flac': {
			if (textDecoder.decode(extraData.subarray(0, 4)) === 'fLaC') {
				return extraData;
			}
			if (extraData.length < FLAC_STREAMINFO_SIZE) {
				return null;
			}
			const description = new Uint8Array(8 + FLAC_STREAMINFO_SIZE);
			description.set([0x66, 0x4C, 0x61, 0x43, ...FLAC_STREAMINFO_BLOCK_HEADER]); // 'fLaC'
			description.set(extraData.subarray(0, FLAC_STREAMINFO_SIZE), 8);
			return description;
		}
		case 'vorbis':
			// Xiph lacing starts with the packet count less one; other layouts are not WebCodecs descriptions
			return extraData[0] === 2 ? extraData : null;
		default:
			return null;
	}
};

abstract class AviTrackBacking implements InputTrackBacking {
	private presentationTimes: AviPresentationTimes | null = null;

	constructor(
		public demuxer: AVIDemuxer,
		public streamInfo: StreamInfo,
	) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	getId(): number {
		return this.streamInfo.index + 1;
	}

	getNumber(): number {
		let number = 0;
		for (const backing of this.demuxer.trackBackings) {
			if (backing.getType() === this.getType()) {
				number++;
			}
			if ((backing as AviTrackBacking) === this) {
				break;
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId(): string | null {
		if (this.streamInfo.header.fccType === 'vids') {
			const format = this.streamInfo.format as AVIBitmapInfoHeader;
			return format.compression;
		} else if (this.streamInfo.header.fccType === 'auds') {
			const format = this.streamInfo.format as AVIWaveFormatEx;
			return format.formatTag.toString();
		}
		return null;
	}

	getName(): string | null {
		return null;
	}

	getLanguageCode(): string {
		return UNDETERMINED_LANGUAGE;
	}

	getTimeResolution(): number {
		if (this.streamInfo.header.rate > 0 && this.streamInfo.header.scale > 0) {
			return this.streamInfo.header.rate / this.streamInfo.header.scale;
		}
		return 1000000;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata(): Promise<number | null> {
		const { header } = this.streamInfo;
		if (header.rate === 0 || header.scale === 0 || header.length === 0) {
			return null;
		}

		return (header.start + header.length) * header.scale / header.rate;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	/** The stream's presentation timestamps, which H.264 and HEVC read from their pictures' order counts. */
	getPresentationTimes() {
		return this.presentationTimes ??= this.demuxer.createPresentationTimes(this.streamInfo, this.getCodec());
	}

	/** Creates the packet at an index of the stream's chunks; its sequence number is that index. */
	private async createPacket(
		res: ResultValue<PacketRetrievalResult>,
		packetIndex: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const packetInfo = this.streamInfo.packets[packetIndex]!;
		const timestamp = await this.getPresentationTimes().getTimestamp(packetIndex);

		if (options.metadataOnly) {
			return res.set(new PacketRetrievalResult(new EncodedPacket(
				PLACEHOLDER_DATA,
				packetInfo.isKey ? 'key' : 'delta',
				timestamp,
				packetInfo.duration,
				packetIndex,
				packetInfo.entry.size,
			)));
		}

		return res.set(new PacketRetrievalResult(
			await this.demuxer.readPacket({ ...packetInfo, timestamp }, packetIndex),
		));
	}

	private getPacketIndex(packet: EncodedPacket) {
		const index = packet.sequenceNumber;
		if (!Number.isInteger(index) || index < 0 || index >= this.streamInfo.packets.length) {
			throw new Error('Packet was not created from this track.');
		}

		return index;
	}

	async getFirstPacket(
		res: ResultValue<PacketRetrievalResult>,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (this.streamInfo.packets.length === 0) {
			return res.set(new PacketRetrievalResult(null));
		}

		return this.createPacket(res, 0, options);
	}

	async getPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const index = await this.getPresentationTimes().findPacket(timestamp);
		if (index === -1) {
			return res.set(new PacketRetrievalResult(null));
		}

		return this.createPacket(res, index, options);
	}

	async getNextPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const nextIndex = this.getPacketIndex(packet) + 1;
		if (nextIndex >= this.streamInfo.packets.length) {
			return res.set(new PacketRetrievalResult(null));
		}

		return this.createPacket(res, nextIndex, options);
	}

	async getKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const index = await this.getPresentationTimes().findKeyPacket(timestamp, this.streamInfo.keyPacketIndices);
		if (index === -1) {
			return res.set(new PacketRetrievalResult(null));
		}

		return this.createPacket(res, index, options);
	}

	async getNextKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const index = this.getPacketIndex(packet);

		// The first key packet after the given one
		const keyPacketIndices = this.streamInfo.keyPacketIndices;
		const keyIndex = binarySearchLessOrEqual(keyPacketIndices, index, x => x) + 1;
		if (keyIndex >= keyPacketIndices.length) {
			return res.set(new PacketRetrievalResult(null));
		}

		return this.createPacket(res, keyPacketIndices[keyIndex]!, options);
	}
}

class AviVideoTrackBacking extends AviTrackBacking implements InputVideoTrackBacking {
	decoderConfigPromise: Promise<VideoDecoderConfig | null> | null = null;

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec | null {
		const format = this.streamInfo.format as AVIBitmapInfoHeader;
		let codec = aviVideoFourccToCodec(format.compression);
		if (!codec || format.compression.trim() === '') {
			codec = aviVideoFourccToCodec(this.streamInfo.header.fccHandler);
		}
		return codec ?? this.streamInfo.identifiedCodec ?? null;
	}

	getCodedWidth(): number {
		const format = this.streamInfo.format as AVIBitmapInfoHeader;
		return Math.abs(format.width);
	}

	getCodedHeight(): number {
		const format = this.streamInfo.format as AVIBitmapInfoHeader;
		return Math.abs(format.height);
	}

	getSquarePixelWidth(): number {
		return this.getCodedWidth();
	}

	getSquarePixelHeight(): number {
		return this.getCodedHeight();
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...IDENTITY_MATRIX];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		const config = await this.getDecoderConfig();
		return config?.colorSpace ?? {};
	}

	async canBeTransparent(): Promise<boolean> {
		return false;
	}

	getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.decoderConfigPromise ??= (async () => {
			const codec = this.getCodec();
			if (!codec) {
				return null;
			}

			const format = this.streamInfo.format as AVIBitmapInfoHeader;

			// AVC and HEVC extradata is a configuration record when the packets are length-prefixed, and the first
			// packet carries the parameter sets when they are in Annex B
			let codecDescription = format.extraData ?? null;
			if ((codec === 'avc' || codec === 'hevc') && codecDescription && codecDescription[0] !== 1) {
				codecDescription = null;
			}

			const needsFirstPacket = codec === 'vp9'
				|| codec === 'av1'
				|| ((codec === 'avc' || codec === 'hevc') && !codecDescription);

			let firstPacket: EncodedPacket | null = null;
			if (needsFirstPacket) {
				const result = new ResultValue<PacketRetrievalResult>();
				const promise = this.getFirstPacket(result, {});
				if (result.pending) await promise;

				firstPacket = result.value.packet;
			}

			const codecInfo = {
				width: this.getCodedWidth(),
				height: this.getCodedHeight(),
				codec,
				codecDescription,
				colorSpace: null,
				avcType: 1 as const,
				avcCodecInfo: codec === 'avc' && firstPacket
					? extractAvcDecoderConfigurationRecord(firstPacket.data)
					: null,
				hevcCodecInfo: codec === 'hevc' && firstPacket
					? extractHevcDecoderConfigurationRecord(firstPacket.data)
					: null,
				vp9CodecInfo: codec === 'vp9' && firstPacket
					? extractVp9CodecInfoFromPacket(firstPacket.data)
					: null,
				av1CodecInfo: codec === 'av1' && firstPacket
					? extractAv1CodecInfoFromPacket(firstPacket.data)
					: null,
				proresCodecInfo: null,
				proresFormat: null,
			};

			return {
				codec: extractVideoCodecString(codecInfo),
				codedWidth: codecInfo.width,
				codedHeight: codecInfo.height,
				description: codecDescription ?? undefined,
				colorSpace: extractColorSpace(codecInfo),
			};
		})();
	}
}

class AviAudioTrackBacking extends AviTrackBacking implements InputAudioTrackBacking {
	decoderConfig: AudioDecoderConfig | null = null;

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec | null {
		return aviWaveFormatToCodec(this.streamInfo.format as AVIWaveFormatEx);
	}

	getNumberOfChannels(): number {
		const format = this.streamInfo.format as AVIWaveFormatEx;
		return format.channels;
	}

	getChannelMask(): number | null {
		return (this.streamInfo.format as AVIWaveFormatEx).extensible?.channelMask ?? null;
	}

	getSampleRate(): number {
		const format = this.streamInfo.format as AVIWaveFormatEx;
		return format.samplesPerSec;
	}

	getHasOnlyKeyPackets() {
		return true;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		const codec = this.getCodec();
		if (!codec) {
			return null;
		}

		const format = this.streamInfo.format as AVIWaveFormatEx;
		const codecDescription = getAudioCodecDescription(codec, format.extraData);

		return this.decoderConfig ??= {
			codec: extractAudioCodecString({
				codec,
				codecDescription,
				// Without an AudioSpecificConfig, assume AAC-LC
				aacCodecInfo: codec === 'aac' ? { isMpeg2: false, objectType: codecDescription ? null : 2 } : null,
				dtsFormat: null,
			}),
			numberOfChannels: this.getNumberOfChannels(),
			sampleRate: this.getSampleRate(),
			description: codecDescription ?? undefined,
		};
	}
}

export class AVIDemuxer extends Demuxer {
	private reader: Reader;
	private mainHeader: AVIMainHeader | null = null;
	private streams: StreamInfo[] = [];
	private index: AVIIndexEntry[] = [];
	private moviStart = 0;
	/** Whether the idx1 offsets count from the file start instead of the movi list. */
	private indexOffsetsAreAbsolute = false;
	trackBackings: (AviVideoTrackBacking | AviAudioTrackBacking)[] = [];
	private metadataPromise: Promise<void> | null = null;

	constructor(input: Input) {
		super(input);
		this.reader = input._reader;
	}

	private static fourcc(bytes: Uint8Array | null): string {
		if (!bytes || bytes.length !== 4) {
			return '    ';
		}
		return textDecoder.decode(bytes);
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		await this.ensureMetadata();
		return this.trackBackings;
	}

	async getMimeType(): Promise<string> {
		return 'video/x-msvideo';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}

	private async ensureMetadata(): Promise<void> {
		if (!this.metadataPromise) {
			this.metadataPromise = this.readMetadata();
		}
		await this.metadataPromise;
	}

	private async readMetadata(): Promise<void> {
		const slice = await this.reader.requestSlice(0, 12);
		if (!slice || slice.remainingLength < 12) {
			throw new Error('Invalid AVI file: insufficient header');
		}

		slice.skip(8); // RIFF and the file size
		const fileType = AVIDemuxer.fourcc(readBytes(slice, 4));

		if (fileType !== 'AVI ') {
			throw new Error('Invalid AVI file type');
		}

		// Parse chunks
		await this.parseChunks();

		// Process index and create packet info
		this.processIndex();

		await this.identifyUntaggedVideo();

		// Create tracks
		this.createTracks();
	}

	/**
	 * Identifies HEVC in a video stream whose header names no codec, as FFmpeg's AVI muxer writes HEVC unless given a
	 * tag: its compression is BI_RGB's zero, and its first chunk starts with HEVC parameter sets. FFmpeg itself reads
	 * such a stream as uncompressed.
	 */
	private async identifyUntaggedVideo() {
		for (const stream of this.streams) {
			const { format } = stream;
			const firstPacket = stream.packets[0];
			if (
				stream.header.fccType !== 'vids'
				|| !('compression' in format)
				|| format.compression !== UNTAGGED_COMPRESSION
				|| aviVideoFourccToCodec(stream.header.fccHandler)
				|| !firstPacket
			) {
				continue;
			}

			const { entry } = firstPacket;
			const chunkPos = this.indexOffsetsAreAbsolute ? entry.offset : this.moviStart + entry.offset;
			const byteCount = Math.min(entry.size, IDENTIFYING_PREFIX_BYTE_COUNT);
			const slice = await this.reader.requestSlice(chunkPos + 8, byteCount);
			if (slice && startsWithHevcParameterSets(readBytes(slice, byteCount))) {
				stream.identifiedCodec = 'hevc';
			}
		}
	}

	private async parseChunks(): Promise<void> {
		let position = 12;

		while (true) {
			const chunk = await this.readChunkHeader(position);
			if (!chunk) {
				break;
			}

			if (chunk.fourcc === 'LIST') {
				const listTypeSlice = await this.reader.requestSlice(position + 8, 4);
				if (!listTypeSlice) {
					break;
				}
				const listType = AVIDemuxer.fourcc(readBytes(listTypeSlice, 4));

				if (listType === 'hdrl') {
					await this.parseHeaderList(position + 12, chunk.size - 4);
				} else if (listType === 'movi') {
					this.moviStart = position + 8;
				}
			} else if (chunk.fourcc === 'idx1') {
				await this.parseIndex(position + 8, chunk.size);
			}

			position += 8 + chunk.size;

			// Align to word boundary
			if (chunk.size % 2 !== 0) {
				position++;
			}
		}
	}

	private async readChunkHeader(position: number): Promise<ChunkInfo | null> {
		const slice = await this.reader.requestSlice(position, 8);
		if (!slice || slice.remainingLength < 8) {
			return null;
		}

		const chunkFourcc = AVIDemuxer.fourcc(readBytes(slice, 4));
		const chunkSize = readU32Le(slice);

		return {
			fourcc: chunkFourcc,
			size: chunkSize,
			position: position + 8,
		};
	}

	private async readChunkData(chunk: ChunkInfo): Promise<DataView | null> {
		const slice = await this.reader.requestSlice(chunk.position, chunk.size);
		if (!slice) {
			return null;
		}

		return new DataView(slice.bytes.buffer, slice.bytes.byteOffset + slice.bufferPos, chunk.size);
	}

	private async parseHeaderList(position: number, size: number): Promise<void> {
		const endPos = position + size;
		let currentPos = position;

		while (currentPos < endPos) {
			const chunk = await this.readChunkHeader(currentPos);
			if (!chunk) {
				break;
			}

			if (chunk.fourcc === 'avih') {
				const data = await this.readChunkData(chunk);
				if (data) {
					this.mainHeader = parseMainHeader(data);
				}
			} else if (chunk.fourcc === 'LIST') {
				const listTypeSlice = await this.reader.requestSlice(chunk.position, 4);
				if (listTypeSlice) {
					const listType = AVIDemuxer.fourcc(readBytes(listTypeSlice, 4));
					if (listType === 'strl') {
						await this.parseStreamList(chunk.position + 4, chunk.size - 4);
					}
				}
			}

			currentPos = chunk.position + chunk.size;

			// Align to word boundary
			if (chunk.size % 2 !== 0) {
				currentPos++;
			}
		}
	}

	private async parseStreamList(position: number, size: number): Promise<void> {
		const endPos = position + size;
		let currentPos = position;
		let header: AVIStreamHeader | null = null;
		let format: AVIBitmapInfoHeader | AVIWaveFormatEx | null = null;

		while (currentPos < endPos) {
			const chunk = await this.readChunkHeader(currentPos);
			if (!chunk) {
				break;
			}

			if (chunk.fourcc === 'strh') {
				const data = await this.readChunkData(chunk);
				if (data) {
					header = parseStreamHeader(data);
				}
			} else if (chunk.fourcc === 'strf') {
				const data = await this.readChunkData(chunk);
				if (data && header) {
					if (header.fccType === 'vids') {
						format = parseBitmapInfoHeader(data);
					} else if (header.fccType === 'auds') {
						format = parseWaveFormatEx(data);
					}
				}
			}

			currentPos = chunk.position + chunk.size;

			// Align to word boundary
			if (chunk.size % 2 !== 0) {
				currentPos++;
			}
		}

		if (header && format) {
			header.sampleSize = getTimingSampleSize(header, format);
		}

		// Every strl takes a stream number, whether or not the stream is usable
		const streamIndex = this.streams.length;
		this.streams.push({
			header: header ?? parseStreamHeader(new DataView(new ArrayBuffer(56))),
			format: format ?? parseWaveFormatEx(new DataView(new ArrayBuffer(16))),
			packets: [],
			keyPacketIndices: [],
			index: streamIndex,
			sampleCount: 0,
		});
		if (!header || !format) {
			this.streams[streamIndex]!.header.fccType = '    ';
		}
	}

	private async parseIndex(position: number, size: number): Promise<void> {
		const slice = await this.reader.requestSlice(position, size);
		if (!slice) {
			return;
		}

		const dataView = new DataView(slice.bytes.buffer, slice.bytes.byteOffset + slice.bufferPos, size);
		const numEntries = Math.floor(size / 16);
		for (let i = 0; i < numEntries; i++) {
			const entry = parseIndexEntry(dataView, i * 16);
			this.index.push(entry);
		}
	}

	private processIndex(): void {
		// idx1 offsets normally count from the movi list's type, but some muxers write file offsets
		const firstEntry = this.index.find(entry => parseStreamChunkId(entry.ckid) !== null);
		this.indexOffsetsAreAbsolute = firstEntry !== undefined && firstEntry.offset >= this.moviStart;

		for (const entry of this.index) {
			const parsed = parseStreamChunkId(entry.ckid);
			if (!parsed) {
				continue;
			}

			const stream = this.streams[parsed.streamNumber];
			if (!stream) {
				continue;
			}

			const { header } = stream;
			const chunkTypes = header.fccType === 'vids' ? VIDEO_CHUNK_TYPES : AUDIO_CHUNK_TYPES;
			if (!chunkTypes.includes(parsed.type)) {
				continue; // Palette changes and other non-media chunks
			}

			// rate / scale samples make a second.
			// A stream with a sample size counts bytes as samples, an audio stream with a block alignment counts its
			// started blocks, and every other stream counts one sample per chunk, as FFmpeg does
			const secondsPerSample = header.rate > 0 && header.scale > 0 ? header.scale / header.rate : 0;
			// FLAC's block alignment is no block size: each chunk holds one frame, which FFmpeg's muxer times by rate
			// and scale
			const blockAlign = 'formatTag' in stream.format
				&& aviWaveFormatToCodec(stream.format) !== 'flac'
				? stream.format.blockAlign
				: 0;
			let sampleCount = 1;
			if (header.sampleSize > 0) {
				sampleCount = entry.size / header.sampleSize;
			} else if (blockAlign > 0) {
				sampleCount = Math.ceil(entry.size / blockAlign);
			}
			const samplesBefore = stream.sampleCount;
			stream.sampleCount += sampleCount;

			// An empty video chunk drops a frame, so it takes time but holds no packet
			if (entry.size === 0) {
				continue;
			}

			const isKey = header.fccType !== 'vids' || (entry.flags & AVIIF_KEYFRAME) !== 0;
			if (isKey) {
				stream.keyPacketIndices.push(stream.packets.length);
			}

			stream.packets.push({
				entry,
				timestamp: (header.start + samplesBefore) * secondsPerSample,
				duration: sampleCount * secondsPerSample,
				isKey,
			});
		}
	}

	private createTracks(): void {
		for (const stream of this.streams) {
			const { header, format } = stream;

			if (header.fccType === 'vids' && 'compression' in format) {
				const backing = new AviVideoTrackBacking(this, stream);
				if (backing.getCodec()) {
					stream.backing = backing;
					this.trackBackings.push(backing);
				}
			} else if (header.fccType === 'auds' && 'formatTag' in format) {
				const backing = new AviAudioTrackBacking(this, stream);
				if (backing.getCodec()) {
					stream.backing = backing;
					this.trackBackings.push(backing);
				}
			}
		}
	}

	/** Returns where an indexed chunk's data starts in the file. */
	private getChunkDataPosition(entry: AVIIndexEntry) {
		return (this.indexOffsetsAreAbsolute ? entry.offset : this.moviStart + entry.offset) + 8;
	}

	/** Creates a stream's presentation times, which read H.264 and HEVC pictures' order counts from their packets. */
	createPresentationTimes(stream: StreamInfo, codec: MediaCodec | null) {
		const extraData = 'compression' in stream.format ? stream.format.extraData ?? null : null;
		let reader: PictureOrderReader | null = null;
		if (codec === 'avc') {
			reader = new AvcPictureOrderReader(extraData);
		} else if (codec === 'hevc') {
			reader = new HevcPictureOrderReader(extraData);
		}

		const { header } = stream;
		const slotDuration = header.rate > 0 && header.scale > 0 ? header.scale / header.rate : 0;

		return new AviPresentationTimes(
			stream.packets,
			stream.keyPacketIndices,
			reader,
			slotDuration,
			async (packetIndex, byteCount) => {
				const slice = await this.reader.requestSlice(
					this.getChunkDataPosition(stream.packets[packetIndex]!.entry),
					byteCount,
				);
				return slice && readBytes(slice, byteCount);
			},
		);
	}

	async readPacket(packetInfo: PacketInfo, sequenceNumber: number): Promise<EncodedPacket | null> {
		const { entry } = packetInfo;
		const slice = await this.reader.requestSlice(this.getChunkDataPosition(entry), entry.size);
		if (!slice) {
			return null;
		}

		const data = readBytes(slice, entry.size);

		return new EncodedPacket(
			data,
			packetInfo.isKey ? 'key' : 'delta',
			packetInfo.timestamp,
			packetInfo.duration,
			sequenceNumber,
			data.byteLength,
		);
	}
}
