/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { Input } from '../input';
import {
	InputVideoTrackBacking,
	InputAudioTrackBacking,
	InputTrackBacking,
} from '../input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
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
} from '../codec-data';
import { Reader, readBytes, readU32Le } from '../reader';
import { TrackType } from '../output';
import {
	textDecoder,
	binarySearchLessOrEqual,
	IDENTITY_MATRIX,
	TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import {
	AVIMainHeader, AVIStreamHeader, AVIBitmapInfoHeader, AVIWaveFormatEx, AVIIndexEntry,
	parseMainHeader, parseStreamHeader, parseBitmapInfoHeader, parseWaveFormatEx, parseIndexEntry,
	aviVideoFourccToCodec, aviAudioFormatTagToCodec, parseStreamChunkId, AVIIF_KEYFRAME,
} from './avi-misc';

type StreamInfo = {
	header: AVIStreamHeader;
	format: AVIBitmapInfoHeader | AVIWaveFormatEx;
	backing?: AviVideoTrackBacking | AviAudioTrackBacking;
	/** The stream's non-empty chunks, in file order, which is decode order. */
	packets: PacketInfo[];
	keyPacketIndices: number[];
	/** The stream's number, which its chunk IDs carry. */
	index: number;
	/** Chunks seen so far, empty ones included, for streams that time chunks by count. */
	chunkCount: number;
	/** Bytes seen so far, for streams that time chunks by size. */
	byteCount: number;
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

const VIDEO_CHUNK_TYPES = ['db', 'dc'];
const AUDIO_CHUNK_TYPES = ['wb'];

abstract class AviTrackBacking implements InputTrackBacking {
	packetToIndex = new WeakMap<EncodedPacket, number>();

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

	private async createPacket(packetIndex: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const packetInfo = this.streamInfo.packets[packetIndex]!;

		let packet: EncodedPacket | null;
		if (options.metadataOnly) {
			packet = new EncodedPacket(
				PLACEHOLDER_DATA,
				packetInfo.isKey ? 'key' : 'delta',
				packetInfo.timestamp,
				packetInfo.duration,
				packetIndex,
				packetInfo.entry.size,
			);
		} else {
			packet = await this.demuxer.readPacket(packetInfo, packetIndex);
		}

		if (packet) {
			this.packetToIndex.set(packet, packetIndex);
		}
		return packet;
	}

	private getPacketIndex(packet: EncodedPacket) {
		const index = this.packetToIndex.get(packet);
		if (index === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return index;
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (this.streamInfo.packets.length === 0) {
			return null;
		}

		return this.createPacket(0, options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const index = binarySearchLessOrEqual(this.streamInfo.packets, timestamp, x => x.timestamp);
		if (index === -1) {
			return null;
		}

		return this.createPacket(index, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const nextIndex = this.getPacketIndex(packet) + 1;
		if (nextIndex >= this.streamInfo.packets.length) {
			return null;
		}

		return this.createPacket(nextIndex, options);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const keyPacketIndices = this.streamInfo.keyPacketIndices;
		const keyIndex = binarySearchLessOrEqual(
			keyPacketIndices,
			timestamp,
			x => this.streamInfo.packets[x]!.timestamp,
		);
		if (keyIndex === -1) {
			return null;
		}

		return this.createPacket(keyPacketIndices[keyIndex]!, options);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const index = this.getPacketIndex(packet);

		// The first key packet after the given one
		const keyPacketIndices = this.streamInfo.keyPacketIndices;
		const keyIndex = binarySearchLessOrEqual(keyPacketIndices, index, x => x) + 1;
		if (keyIndex >= keyPacketIndices.length) {
			return null;
		}

		return this.createPacket(keyPacketIndices[keyIndex]!, options);
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
		return codec;
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

			const firstPacket = needsFirstPacket ? await this.getFirstPacket({}) : null;

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
		const format = this.streamInfo.format as AVIWaveFormatEx;
		return aviAudioFormatTagToCodec(format.formatTag, format.bitsPerSample);
	}

	getNumberOfChannels(): number {
		const format = this.streamInfo.format as AVIWaveFormatEx;
		return format.channels;
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
		// Only AAC's extradata, its AudioSpecificConfig, is a decoder description
		const codecDescription = codec === 'aac' ? format.extraData ?? null : null;

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

		// Create tracks
		this.createTracks();
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

		// Every strl takes a stream number, whether or not the stream is usable
		const streamIndex = this.streams.length;
		this.streams.push({
			header: header ?? parseStreamHeader(new DataView(new ArrayBuffer(56))),
			format: format ?? parseWaveFormatEx(new DataView(new ArrayBuffer(16))),
			packets: [],
			keyPacketIndices: [],
			index: streamIndex,
			chunkCount: 0,
			byteCount: 0,
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

			// A stream with a sample size times its chunks by their byte count, and every other stream counts one
			// sample per chunk; either way, rate / scale samples make a second
			const secondsPerSample = header.rate > 0 && header.scale > 0 ? header.scale / header.rate : 0;
			const samplesBefore = header.sampleSize > 0
				? stream.byteCount / header.sampleSize
				: stream.chunkCount;
			const sampleCount = header.sampleSize > 0 ? entry.size / header.sampleSize : 1;

			stream.chunkCount++;
			stream.byteCount += entry.size;

			// An empty chunk drops a frame, so it takes time but holds no packet
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

	async readPacket(packetInfo: PacketInfo, sequenceNumber: number): Promise<EncodedPacket | null> {
		const { entry } = packetInfo;
		const chunkPos = this.indexOffsetsAreAbsolute ? entry.offset : this.moviStart + entry.offset;
		const slice = await this.reader.requestSlice(chunkPos + 8, entry.size);
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
