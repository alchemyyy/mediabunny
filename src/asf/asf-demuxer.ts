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
import { InputAudioTrackBacking, InputTrackBacking, InputVideoTrackBacking } from '../input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import {
	AudioCodec,
	MediaCodec,
	VideoCodec,
	extractAudioCodecString,
	extractColorSpace,
	extractVideoCodecString,
} from '../codec';
import { extractAvcDecoderConfigurationRecord, extractHevcDecoderConfigurationRecord } from '../codec-data';
import { Reader, readBytes } from '../reader';
import { TrackType } from '../output';
import {
	IDENTITY_MATRIX,
	MaybeRelevantPromise,
	ResultValue,
	TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import {
	AVIBitmapInfoHeader,
	AVIWaveFormatEx,
	aviWaveFormatToCodec,
	parseBitmapInfoHeader,
	parseWaveFormatEx,
} from '../avi/avi-misc';
import { getAudioCodecDescription } from '../avi/avi-demuxer';
import {
	ASF_ADVANCED_CONTENT_ENCRYPTION_OBJECT,
	ASF_AUDIO_MEDIA,
	ASF_AUDIO_SPREAD,
	ASF_BROADCAST_FLAG,
	ASF_CODEC_LIST_OBJECT,
	ASF_CONTENT_DESCRIPTION_OBJECT,
	ASF_CONTENT_ENCRYPTION_OBJECT,
	ASF_DATA_OBJECT,
	ASF_DATA_OBJECT_FIELDS_SIZE,
	ASF_ENCRYPTED_CONTENT_FLAG,
	ASF_EXTENDED_CONTENT_DESCRIPTION_OBJECT,
	ASF_EXTENDED_CONTENT_ENCRYPTION_OBJECT,
	ASF_EXTENDED_STREAM_PROPERTIES_OBJECT,
	ASF_FILE_PROPERTIES_OBJECT,
	ASF_HEADER_EXTENSION_FIELDS_SIZE,
	ASF_HEADER_EXTENSION_OBJECT,
	ASF_HEADER_OBJECT,
	ASF_HEADER_OBJECT_FIELDS_SIZE,
	ASF_INDEX_OBJECT,
	ASF_OBJECT_HEADER_SIZE,
	ASF_SIMPLE_INDEX_OBJECT,
	ASF_STREAM_BITRATE_PROPERTIES_OBJECT,
	ASF_STREAM_PROPERTIES_OBJECT,
	ASF_VIDEO_MEDIA,
	asfVideoFourccToCodec,
	getUint64Le,
	guidEquals,
	readUtf16Le,
	readVariableField,
} from './asf-misc';

/**
 * The error a protected ASF file raises: its header holds a Content Encryption, Extended Content Encryption, or
 * Advanced Content Encryption Object, or a stream is flagged as encrypted. Its payloads cannot be read without a
 * license, so the demuxer refuses the file rather than hand out encrypted packets.
 */
export const ASF_DRM_ERROR_MESSAGE = 'ASF file is DRM-protected; protected content cannot be demuxed.';

/** The audio spread error correction of a stream, which scrambles each media object in chunks, as FFmpeg reads it. */
type AudioSpread = {
	span: number;
	virtualPacketLength: number;
	virtualChunkLength: number;
};

/** A key frame index of a stream: for each multiple of the interval, the data packet its key frame starts in. */
type KeyFrameIndex = {
	/** The interval between entries, in milliseconds of presentation time. */
	interval: number;
	packetIndices: number[];
};

type StreamInfo = {
	/** The stream's number, 1 to 127, which its payloads carry. */
	number: number;
	type: 'video' | 'audio';
	/**
	 * The stream's format, in the fields the AVI demuxer's streams carry: a video stream's BITMAPINFOHEADER and its
	 * extradata, or an audio stream's WAVEFORMATEX and its extradata.
	 */
	format: AVIBitmapInfoHeader | AVIWaveFormatEx;
	spread: AudioSpread | null;
	/** The average time per frame of the Extended Stream Properties Object, in seconds, or null. */
	frameDuration: number | null;
	/** The data bitrate of the Extended Stream Properties Object, in bits per second, or null. */
	peakBitrate: number | null;
	/** The bitrate of the Stream Bitrate Properties Object, in bits per second, or null. */
	averageBitrate: number | null;
	keyFrameIndex: KeyFrameIndex | null;
	backing?: AsfVideoTrackBacking | AsfAudioTrackBacking;
};

/** A payload of a data packet: a fragment of a media object, or a whole one from a compressed payload. */
type Payload = {
	streamNumber: number;
	isKey: boolean;
	objectNumber: number;
	/** Where the fragment starts in its media object. */
	offset: number;
	objectSize: number;
	/** The media object's presentation time, in milliseconds, which counts the preroll. */
	presentationTime: number;
	/** The file position of the payload's data. */
	position: number;
	length: number;
	/** Whether the file ends within the payload, which so holds only the length before the end. */
	truncated: boolean;
};

type DataPacket = {
	/** The packet's send time, in milliseconds. */
	sendTime: number;
	payloads: Payload[];
};

/** Where a payload is: its data packet and its place among the packet's payloads. */
type PayloadLocation = {
	packetIndex: number;
	ordinal: number;
	payload: Payload;
};

/**
 * A media object whose fragments the data packets hold in full, or up to where the file ends within one of them; its
 * size is then what the fragments hold.
 */
type MediaObject = {
	location: PayloadLocation;
	fragments: Payload[];
	size: number;
};

// A packet's sequence number is its first payload's location, packed into one number
const PAYLOADS_PER_PACKET_LIMIT = 0x10000;
// The size FFmpeg's asfdec_f.c refuses a media object at or above
const MAX_MEDIA_OBJECT_SIZE = 1 << 24;
// The parsed data packets kept, as a bound on memory
const DATA_PACKET_CACHE_SIZE = 4096;
// The data packets a backward search reads first, doubling each time it reads further back
const INITIAL_SEARCH_WINDOW = 16;
// The objects that may follow the Data Object before an index, as a bound on a malformed file's reads
const MAX_TRAILING_OBJECTS = 64;
// Index objects past this size are not read
const MAX_INDEX_OBJECT_SIZE = 64 * 1024 * 1024;
// The header past this size is not read
const MAX_HEADER_OBJECT_SIZE = 256 * 1024 * 1024;
// The data packets a media object may spread its fragments over, past those its size needs at the least
const OBJECT_FRAGMENT_PACKET_SLACK = 64;
// The smallest data packet header: the payload parsing information's flags, send time, and duration
const MIN_PACKET_HEADER_SIZE = 8;

const ESP_STREAM_NUMBER_OFFSET = 48;
const ESP_AVERAGE_TIME_PER_FRAME_OFFSET = 52;
const ESP_STREAM_NAME_COUNT_OFFSET = 60;
// The Stream Properties Object's object header and fields up to its type-specific data
const SPO_TYPE_SPECIFIC_DATA_OFFSET = 78;
// A video stream's type-specific data: its encoded size, a reserved byte, and its format data size
const VIDEO_TYPE_SPECIFIC_HEADER_SIZE = 11;
const BITMAP_INFO_HEADER_SIZE = 40;
const WAVE_FORMAT_MIN_SIZE = 16;

const toView = (bytes: Uint8Array, offset = 0, length = bytes.length - offset) =>
	new DataView(bytes.buffer, bytes.byteOffset + offset, length);

/**
 * Undoes audio spread scrambling, as FFmpeg's demuxer does: the object's chunks are stored column by column of a span
 * by virtual packet grid.
 */
const descramble = (data: Uint8Array, spread: AudioSpread) => {
	const { span, virtualPacketLength, virtualChunkLength } = spread;
	if (data.length !== virtualPacketLength * span) {
		return data;
	}

	const result = new Uint8Array(data.length);
	for (let offset = 0; offset < data.length; offset += virtualChunkLength) {
		const chunk = offset / virtualChunkLength;
		const row = Math.floor(chunk / span);
		const column = chunk % span;
		const index = row + column * virtualPacketLength / virtualChunkLength;
		result.set(data.subarray(index * virtualChunkLength, (index + 1) * virtualChunkLength), offset);
	}
	return result;
};

abstract class AsfTrackBacking implements InputTrackBacking {
	constructor(
		public demuxer: AsfDemuxer,
		public streamInfo: StreamInfo,
	) {}

	abstract getType(): TrackType;
	abstract getCodec(): MediaCodec | null;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
	abstract getInternalCodecId(): string;
	/** The duration of a media object, in seconds. */
	abstract getObjectDuration(object: MediaObject): Promise<number>;

	getId(): number {
		return this.streamInfo.number;
	}

	getNumber(): number {
		let number = 0;
		for (const backing of this.demuxer.trackBackings) {
			if (backing.getType() === this.getType()) {
				number++;
			}
			if ((backing as AsfTrackBacking) === this) {
				break;
			}
		}
		return number;
	}

	getName(): string | null {
		return null;
	}

	getLanguageCode(): string {
		return UNDETERMINED_LANGUAGE;
	}

	getTimeResolution(): number {
		// Presentation times are in milliseconds
		return 1000;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getDisposition(): TrackDisposition {
		return { ...DEFAULT_TRACK_DISPOSITION };
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return this.streamInfo.peakBitrate;
	}

	getAverageBitrate() {
		return this.streamInfo.averageBitrate;
	}

	async getDurationFromMetadata(): Promise<number | null> {
		return this.demuxer.getDurationFromMetadata();
	}

	async getLiveRefreshInterval() {
		return null;
	}

	private async createPacket(
		res: ResultValue<PacketRetrievalResult>,
		object: MediaObject | null,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (!object) {
			return res.set(new PacketRetrievalResult(null));
		}

		const { location } = object;
		const { payload } = location;
		const isKey = this.streamInfo.type === 'audio' || payload.isKey;
		const timestamp = (payload.presentationTime - this.demuxer.preroll) / 1000;
		const duration = await this.getObjectDuration(object);
		const sequenceNumber = location.packetIndex * PAYLOADS_PER_PACKET_LIMIT + location.ordinal;

		if (options.metadataOnly) {
			return res.set(new PacketRetrievalResult(new EncodedPacket(
				PLACEHOLDER_DATA,
				isKey ? 'key' : 'delta',
				timestamp,
				duration,
				sequenceNumber,
				object.size,
			)));
		}

		const data = await this.demuxer.readMediaObject(object, this.streamInfo);
		if (!data) {
			return res.set(new PacketRetrievalResult(null));
		}

		return res.set(new PacketRetrievalResult(new EncodedPacket(
			data,
			isKey ? 'key' : 'delta',
			timestamp,
			duration,
			sequenceNumber,
			data.byteLength,
		)));
	}

	/** Returns the data packet and payload a packet of this track was created from. */
	private getPacketLocation(packet: EncodedPacket) {
		const sequenceNumber = packet.sequenceNumber;
		if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) {
			throw new Error('Packet was not created from this track.');
		}
		return {
			packetIndex: Math.floor(sequenceNumber / PAYLOADS_PER_PACKET_LIMIT),
			ordinal: sequenceNumber % PAYLOADS_PER_PACKET_LIMIT,
		};
	}

	async getFirstPacket(
		res: ResultValue<PacketRetrievalResult>,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const object = await this.demuxer.findNextObject(this.streamInfo, 0, 0, false);
		return this.createPacket(res, object, options);
	}

	async getNextPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const { packetIndex, ordinal } = this.getPacketLocation(packet);
		const object = await this.demuxer.findNextObject(this.streamInfo, packetIndex, ordinal + 1, false);
		return this.createPacket(res, object, options);
	}

	async getPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const object = await this.demuxer.findLastObject(this.streamInfo, timestamp, false);
		return this.createPacket(res, object, options);
	}

	async getKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const keyOnly = this.streamInfo.type === 'video';
		const object = await this.demuxer.findLastObject(this.streamInfo, timestamp, keyOnly);
		return this.createPacket(res, object, options);
	}

	async getNextKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const { packetIndex, ordinal } = this.getPacketLocation(packet);
		const keyOnly = this.streamInfo.type === 'video';
		const object = await this.demuxer.findNextObject(this.streamInfo, packetIndex, ordinal + 1, keyOnly);
		return this.createPacket(res, object, options);
	}
}

class AsfVideoTrackBacking extends AsfTrackBacking implements InputVideoTrackBacking {
	private decoderConfigPromise: Promise<VideoDecoderConfig | null> | null = null;

	private frameDurationPromise: Promise<number> | null = null;

	getType() {
		return 'video' as const;
	}

	private get bitmapInfoHeader() {
		return this.streamInfo.format as AVIBitmapInfoHeader;
	}

	getCodec(): VideoCodec | null {
		return asfVideoFourccToCodec(this.bitmapInfoHeader.compression);
	}

	/** The stream's FourCC, as the AVI demuxer gives it, which names the codec of a stream Mediabunny has none for. */
	getInternalCodecId(): string {
		return this.bitmapInfoHeader.compression;
	}

	/**
	 * A frame's duration: the average time per frame of the Extended Stream Properties Object, or else the time
	 * between the stream's first two media objects, as FFmpeg's muxer writes no such object and stamps frames a frame
	 * apart in decode order.
	 */
	getObjectDuration(): Promise<number> {
		return this.frameDurationPromise ??= (async () => {
			if (this.streamInfo.frameDuration !== null) {
				return this.streamInfo.frameDuration;
			}
			const first = await this.demuxer.findNextObject(this.streamInfo, 0, 0, false);
			if (!first) {
				return 0;
			}
			const { location } = first;
			const { packetIndex, ordinal } = location;
			const second = await this.demuxer.findNextObject(this.streamInfo, packetIndex, ordinal + 1, false);
			if (!second) {
				return 0;
			}
			const delta = second.location.payload.presentationTime - location.payload.presentationTime;
			return Math.max(delta, 0) / 1000;
		})();
	}

	getCodedWidth(): number {
		return Math.abs(this.bitmapInfoHeader.width);
	}

	getCodedHeight(): number {
		return Math.abs(this.bitmapInfoHeader.height);
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

			// The BITMAPINFOHEADER's extradata: VC-1's sequence header and entry point, MPEG-4 Part 2's video object
			// layer, or an AVC or HEVC configuration record, whose absence leaves the parameter sets to the stream
			let codecDescription = this.bitmapInfoHeader.extraData ?? null;
			if ((codec === 'avc' || codec === 'hevc') && codecDescription && codecDescription[0] !== 1) {
				codecDescription = null;
			}

			let firstPacket: EncodedPacket | null = null;
			if ((codec === 'avc' || codec === 'hevc') && !codecDescription) {
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
				vp9CodecInfo: null,
				av1CodecInfo: null,
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

class AsfAudioTrackBacking extends AsfTrackBacking implements InputAudioTrackBacking {
	private decoderConfig: AudioDecoderConfig | null = null;

	getType() {
		return 'audio' as const;
	}

	private get waveFormat() {
		return this.streamInfo.format as AVIWaveFormatEx;
	}

	getCodec(): AudioCodec | null {
		return aviWaveFormatToCodec(this.waveFormat);
	}

	/** The stream's format tag, in decimal as the AVI demuxer gives it, which names a codec Mediabunny has none for. */
	getInternalCodecId(): string {
		return this.waveFormat.formatTag.toString();
	}

	async getObjectDuration(object: MediaObject): Promise<number> {
		const { avgBytesPerSec } = this.waveFormat;
		return avgBytesPerSec > 0 ? object.size / avgBytesPerSec : 0;
	}

	getNumberOfChannels(): number {
		return this.waveFormat.channels;
	}

	getChannelMask(): number | null {
		return this.waveFormat.extensible?.channelMask ?? null;
	}

	getSampleRate(): number {
		return this.waveFormat.samplesPerSec;
	}

	getHasOnlyKeyPackets() {
		return true;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		const codec = this.getCodec();
		if (!codec) {
			return null;
		}

		const codecDescription = getAudioCodecDescription(codec, this.waveFormat.extraData);
		return this.decoderConfig ??= {
			codec: extractAudioCodecString({
				codec,
				codecDescription,
				aacCodecInfo: codec === 'aac' ? { isMpeg2: false, objectType: codecDescription ? null : 2 } : null,
				dtsFormat: null,
			}),
			numberOfChannels: this.getNumberOfChannels(),
			sampleRate: this.getSampleRate(),
			description: codecDescription ?? undefined,
		};
	}
}

/**
 * Demuxes ASF (Advanced Systems Format), the container of .asf, .wmv, and .wma files, following the ASF specification
 * and FFmpeg's libavformat/asfdec_f.c. The header's objects give the streams and the fixed data packet size; the data
 * packets are read on demand, each media object assembled from its payloads, and timestamped with its presentation
 * time less the preroll, as FFmpeg stamps it. A key frame search reads the Simple Index or Index Object when the file
 * has one, and otherwise bisects the data packets by their send times, as FFmpeg's asf_read_pts does.
 */
export class AsfDemuxer extends Demuxer {
	private reader: Reader;
	private metadataPromise: Promise<void> | null = null;
	private indexPromise: Promise<void> | null = null;
	private streams = new Map<number, StreamInfo>();
	private metadataTags: MetadataTags = {};
	trackBackings: (AsfVideoTrackBacking | AsfAudioTrackBacking)[] = [];

	/** The preroll, in milliseconds, which presentation times count. */
	preroll = 0;
	private flags = 0;
	/** The play duration, in milliseconds, which counts the preroll. */
	private playDuration = 0;
	private packetSize = 0;
	private firstPacketPosition = 0;
	private packetCount = 0;
	/** The end of the Data Object, where the index objects may follow. */
	private dataObjectEnd = 0;
	private dataPackets = new Map<number, Promise<DataPacket | null>>();

	constructor(input: Input) {
		super(input);
		this.reader = input._reader;
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		await this.ensureMetadata();
		return this.trackBackings;
	}

	async getMimeType(): Promise<string> {
		await this.ensureMetadata();
		return this.trackBackings.some(backing => backing.getType() === 'video') ? 'video/x-ms-asf' : 'audio/x-ms-wma';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		await this.ensureMetadata();
		return this.metadataTags;
	}

	getDurationFromMetadata(): number | null {
		if (this.flags & ASF_BROADCAST_FLAG || this.playDuration <= 0) {
			return null;
		}
		return Math.max(this.playDuration - this.preroll, 0) / 1000;
	}

	private ensureMetadata() {
		return this.metadataPromise ??= this.readMetadata();
	}

	private async readMetadata() {
		const headerStart = await this.reader.requestSlice(0, ASF_OBJECT_HEADER_SIZE + ASF_HEADER_OBJECT_FIELDS_SIZE);
		if (!headerStart) {
			throw new Error('Invalid ASF file: insufficient header.');
		}
		const start = readBytes(headerStart, ASF_OBJECT_HEADER_SIZE);
		const headerSize = getUint64Le(toView(start), 16);
		const minimumHeaderSize = ASF_OBJECT_HEADER_SIZE + ASF_HEADER_OBJECT_FIELDS_SIZE;
		if (!guidEquals(start, 0, ASF_HEADER_OBJECT) || headerSize < minimumHeaderSize) {
			throw new Error('Invalid ASF file: no Header Object.');
		}
		if (headerSize > MAX_HEADER_OBJECT_SIZE) {
			throw new Error('Invalid ASF file: Header Object too large.');
		}

		const headerSlice = await this.reader.requestSlice(0, headerSize);
		if (!headerSlice) {
			throw new Error('Invalid ASF file: truncated Header Object.');
		}
		const header = readBytes(headerSlice, headerSize);

		const extendedProperties = new Map<number, { frameDuration: number | null; peakBitrate: number | null }>();
		const averageBitrates = new Map<number, number>();
		this.readObjects(
			header,
			ASF_OBJECT_HEADER_SIZE + ASF_HEADER_OBJECT_FIELDS_SIZE,
			headerSize,
			extendedProperties,
			averageBitrates,
		);

		if (this.packetSize === 0) {
			throw new Error('Invalid ASF file: no File Properties Object.');
		}

		for (const stream of this.streams.values()) {
			const extended = extendedProperties.get(stream.number);
			stream.frameDuration = extended?.frameDuration ?? null;
			stream.peakBitrate = extended?.peakBitrate ?? null;
			stream.averageBitrate = averageBitrates.get(stream.number) ?? null;
		}

		await this.readDataObjectHeader(headerSize);

		// Tracks keep the order the header lists their streams in, as FFmpeg creates its streams in its header walk
		for (const stream of this.streams.values()) {
			const backing = stream.type === 'video'
				? new AsfVideoTrackBacking(this, stream)
				: new AsfAudioTrackBacking(this, stream);
			stream.backing = backing;
			this.trackBackings.push(backing);
		}
	}

	/** Reads the objects in a range of the header, descending into the Header Extension Object. */
	private readObjects(
		header: Uint8Array,
		start: number,
		end: number,
		extendedProperties: Map<number, { frameDuration: number | null; peakBitrate: number | null }>,
		averageBitrates: Map<number, number>,
	) {
		let position = start;
		while (position + ASF_OBJECT_HEADER_SIZE <= end) {
			const size = getUint64Le(toView(header, position, ASF_OBJECT_HEADER_SIZE), 16);
			if (size < ASF_OBJECT_HEADER_SIZE || position + size > end) {
				break;
			}

			if (
				guidEquals(header, position, ASF_CONTENT_ENCRYPTION_OBJECT)
				|| guidEquals(header, position, ASF_EXTENDED_CONTENT_ENCRYPTION_OBJECT)
				|| guidEquals(header, position, ASF_ADVANCED_CONTENT_ENCRYPTION_OBJECT)
			) {
				throw new Error(ASF_DRM_ERROR_MESSAGE);
			}

			const object = header.subarray(position, position + size);
			try {
				if (guidEquals(object, 0, ASF_FILE_PROPERTIES_OBJECT)) {
					this.readFileProperties(object);
				} else if (guidEquals(object, 0, ASF_STREAM_PROPERTIES_OBJECT)) {
					this.readStreamProperties(object);
				} else if (guidEquals(object, 0, ASF_HEADER_EXTENSION_OBJECT)) {
					const dataStart = ASF_OBJECT_HEADER_SIZE + ASF_HEADER_EXTENSION_FIELDS_SIZE;
					const dataSize = toView(object).getUint32(dataStart - 4, true);
					this.readObjects(
						header,
						position + dataStart,
						Math.min(position + dataStart + dataSize, position + size),
						extendedProperties,
						averageBitrates,
					);
				} else if (guidEquals(object, 0, ASF_EXTENDED_STREAM_PROPERTIES_OBJECT)) {
					this.readExtendedStreamProperties(object, extendedProperties);
				} else if (guidEquals(object, 0, ASF_STREAM_BITRATE_PROPERTIES_OBJECT)) {
					const view = toView(object);
					const count = view.getUint16(ASF_OBJECT_HEADER_SIZE, true);
					for (let i = 0; i < count; i++) {
						const offset = ASF_OBJECT_HEADER_SIZE + 2 + i * 6;
						averageBitrates.set(view.getUint16(offset, true) & 0x7f, view.getUint32(offset + 2, true));
					}
				} else if (guidEquals(object, 0, ASF_CONTENT_DESCRIPTION_OBJECT)) {
					this.readContentDescription(object);
				} else if (guidEquals(object, 0, ASF_EXTENDED_CONTENT_DESCRIPTION_OBJECT)) {
					this.readExtendedContentDescription(object);
				} else if (guidEquals(object, 0, ASF_CODEC_LIST_OBJECT)) {
					this.readCodecList(object);
				}
			} catch (error) {
				// A malformed object reads past its end, and is passed over as FFmpeg passes over what it cannot read
				if (!(error instanceof RangeError)) {
					throw error;
				}
			}

			position += size;
		}
	}

	private readFileProperties(object: Uint8Array) {
		const view = toView(object);
		// File ID, file size, creation date, and data packet count precede the play duration
		this.playDuration = getUint64Le(view, 64) / 10000;
		this.preroll = getUint64Le(view, 80);
		this.flags = view.getUint32(88, true);
		const minimumPacketSize = view.getUint32(92, true);
		const maximumPacketSize = view.getUint32(96, true);
		if (minimumPacketSize !== maximumPacketSize || maximumPacketSize === 0 || maximumPacketSize >= 1 << 29) {
			// A file's data packets are all of one size, which locates them; only a live stream's may vary
			throw new Error('Unsupported ASF file: data packets of varying size.');
		}
		this.packetSize = maximumPacketSize;
	}

	private readStreamProperties(object: Uint8Array) {
		const view = toView(object);
		const typeSpecificLength = view.getUint32(64, true);
		const errorCorrectionLength = view.getUint32(68, true);
		const flags = view.getUint16(72, true);
		const number = flags & 0x7f;
		if (flags & ASF_ENCRYPTED_CONTENT_FLAG) {
			throw new Error(ASF_DRM_ERROR_MESSAGE);
		}
		if (number === 0 || this.streams.has(number)) {
			return;
		}

		const typeSpecificEnd = SPO_TYPE_SPECIFIC_DATA_OFFSET + typeSpecificLength;
		const typeSpecific = object.subarray(SPO_TYPE_SPECIFIC_DATA_OFFSET, typeSpecificEnd);
		if (typeSpecific.length !== typeSpecificLength) {
			return;
		}
		const errorCorrection = object.subarray(typeSpecificEnd, typeSpecificEnd + errorCorrectionLength);

		const base = {
			number,
			spread: null,
			frameDuration: null,
			peakBitrate: null,
			averageBitrate: null,
			keyFrameIndex: null,
		};

		if (guidEquals(object, ASF_OBJECT_HEADER_SIZE, ASF_AUDIO_MEDIA)) {
			if (typeSpecific.length < WAVE_FORMAT_MIN_SIZE) {
				return;
			}
			let spread: AudioSpread | null = null;
			if (guidEquals(object, ASF_OBJECT_HEADER_SIZE + 16, ASF_AUDIO_SPREAD) && errorCorrection.length >= 5) {
				const errorCorrectionView = toView(errorCorrection);
				spread = {
					span: errorCorrection[0]!,
					virtualPacketLength: errorCorrectionView.getUint16(1, true),
					virtualChunkLength: errorCorrectionView.getUint16(3, true),
				};
				// FFmpeg descrambles only a span over more than one chunk of a whole number of chunks per packet
				if (
					spread.span <= 1
					|| spread.virtualChunkLength === 0
					|| spread.virtualPacketLength / spread.virtualChunkLength <= 1
					|| spread.virtualPacketLength % spread.virtualChunkLength !== 0
				) {
					spread = null;
				}
			}
			this.streams.set(number, {
				...base,
				type: 'audio',
				format: parseWaveFormatEx(toView(typeSpecific)),
				spread,
			});
		} else if (guidEquals(object, ASF_OBJECT_HEADER_SIZE, ASF_VIDEO_MEDIA)) {
			if (typeSpecific.length < VIDEO_TYPE_SPECIFIC_HEADER_SIZE + BITMAP_INFO_HEADER_SIZE) {
				return;
			}
			const typeSpecificView = toView(typeSpecific);
			const formatDataSize = typeSpecificView.getUint16(9, true);
			const formatData = typeSpecific.subarray(
				VIDEO_TYPE_SPECIFIC_HEADER_SIZE,
				VIDEO_TYPE_SPECIFIC_HEADER_SIZE + formatDataSize,
			);
			// As FFmpeg reads it, the extradata is what the BITMAPINFOHEADER's size counts past its 40 bytes
			const headerSize = toView(formatData).getUint32(0, true);
			const bitmapInfoHeaderSize = Math.max(BITMAP_INFO_HEADER_SIZE, Math.min(headerSize, formatData.length));
			this.streams.set(number, {
				...base,
				type: 'video',
				format: parseBitmapInfoHeader(toView(formatData, 0, bitmapInfoHeaderSize)),
			});
		}
		// Command, JFIF, and other streams are not media this demuxer hands out
	}

	private readExtendedStreamProperties(
		object: Uint8Array,
		extendedProperties: Map<number, { frameDuration: number | null; peakBitrate: number | null }>,
	) {
		const view = toView(object);
		const fields = ASF_OBJECT_HEADER_SIZE;
		const dataBitrate = view.getUint32(fields + 16, true);
		const number = view.getUint16(fields + ESP_STREAM_NUMBER_OFFSET, true) & 0x7f;
		const averageTimePerFrame = getUint64Le(view, fields + ESP_AVERAGE_TIME_PER_FRAME_OFFSET);
		const streamNameCount = view.getUint16(fields + ESP_STREAM_NAME_COUNT_OFFSET, true);
		const payloadExtensionCount = view.getUint16(fields + ESP_STREAM_NAME_COUNT_OFFSET + 2, true);
		extendedProperties.set(number, {
			frameDuration: averageTimePerFrame > 0 ? averageTimePerFrame / 10_000_000 : null,
			peakBitrate: dataBitrate > 0 ? dataBitrate : null,
		});

		let position = fields + ESP_STREAM_NAME_COUNT_OFFSET + 4;
		for (let i = 0; i < streamNameCount; i++) {
			position += 4 + view.getUint16(position + 2, true);
		}
		for (let i = 0; i < payloadExtensionCount; i++) {
			position += 22 + view.getUint32(position + 18, true);
		}

		// A Stream Properties Object of a stream the header does not list may follow
		if (
			position + ASF_OBJECT_HEADER_SIZE <= object.length
			&& guidEquals(object, position, ASF_STREAM_PROPERTIES_OBJECT)
		) {
			const size = getUint64Le(view, position + 16);
			if (position + size <= object.length) {
				this.readStreamProperties(object.subarray(position, position + size));
			}
		}
	}

	private readContentDescription(object: Uint8Array) {
		const view = toView(object);
		const lengths = [0, 1, 2, 3, 4].map(i => view.getUint16(ASF_OBJECT_HEADER_SIZE + i * 2, true));
		const strings: string[] = [];
		let position = ASF_OBJECT_HEADER_SIZE + 10;
		for (const length of lengths) {
			if (position + length > object.length) {
				throw new RangeError('Content description past its object.');
			}
			strings.push(readUtf16Le(object.subarray(position, position + length)));
			position += length;
		}

		const [title, author, copyright, description, rating] = strings as [string, string, string, string, string];
		const raw = this.metadataTags.raw ??= {};
		const entries: [string, string][] = [
			['Title', title], ['Author', author], ['Copyright', copyright], ['Description', description],
			['Rating', rating],
		];
		for (const [key, value] of entries) {
			if (value) {
				raw[key] = value;
			}
		}
		if (title) this.metadataTags.title = title;
		if (author) this.metadataTags.artist = author;
		if (description) this.metadataTags.comment = description;
	}

	private readExtendedContentDescription(object: Uint8Array) {
		const view = toView(object);
		const count = view.getUint16(ASF_OBJECT_HEADER_SIZE, true);
		const raw = this.metadataTags.raw ??= {};
		let position = ASF_OBJECT_HEADER_SIZE + 2;
		for (let i = 0; i < count; i++) {
			const nameLength = view.getUint16(position, true);
			const name = readUtf16Le(object.subarray(position + 2, position + 2 + nameLength));
			position += 2 + nameLength;
			const valueType = view.getUint16(position, true);
			const valueLength = view.getUint16(position + 2, true);
			const value = object.subarray(position + 4, position + 4 + valueLength);
			if (value.length !== valueLength) {
				throw new RangeError('Descriptor past its object.');
			}
			position += 4 + valueLength;

			let text: string | null = null;
			if (valueType === 0) {
				text = readUtf16Le(value);
			} else if (valueType >= 2 && valueType <= 5 && valueLength > 0) {
				// BOOL and DWORD are 32 bits here, QWORD 64, WORD 16
				const valueView = toView(value);
				text = String(valueLength >= 8
					? getUint64Le(valueView, 0)
					: valueLength >= 4 ? valueView.getUint32(0, true) : valueView.getUint16(0, true));
			}
			raw[name] = text ?? value.slice();

			if (text === null) {
				continue;
			}
			switch (name) {
				case 'WM/AlbumTitle':
					this.metadataTags.album = text;
					break;
				case 'WM/AlbumArtist':
					this.metadataTags.albumArtist = text;
					break;
				case 'WM/Genre':
					this.metadataTags.genre = text;
					break;
				case 'WM/TrackNumber': {
					const trackNumber = Number.parseInt(text, 10);
					if (Number.isInteger(trackNumber) && trackNumber > 0) {
						this.metadataTags.trackNumber = trackNumber;
					}
					break;
				}
			}
		}
	}

	/** Reads the Codec List Object's codec names into the raw tags, as `CodecList`. */
	private readCodecList(object: Uint8Array) {
		const view = toView(object);
		const count = view.getUint32(ASF_OBJECT_HEADER_SIZE + 16, true);
		const names: string[] = [];
		let position = ASF_OBJECT_HEADER_SIZE + 20;
		for (let i = 0; i < count; i++) {
			const nameLength = view.getUint16(position + 2, true) * 2;
			names.push(readUtf16Le(object.subarray(position + 4, position + 4 + nameLength)));
			position += 4 + nameLength;
			position += 2 + view.getUint16(position, true) * 2; // The description
			position += 2 + view.getUint16(position, true); // The codec's information
			if (position > object.length) {
				throw new RangeError('Codec entry past its object.');
			}
		}
		(this.metadataTags.raw ??= {})['CodecList'] = names;
	}

	private async readDataObjectHeader(headerSize: number) {
		const slice = await this.reader.requestSlice(headerSize, ASF_OBJECT_HEADER_SIZE + ASF_DATA_OBJECT_FIELDS_SIZE);
		if (!slice) {
			throw new Error('Invalid ASF file: no Data Object.');
		}
		const bytes = readBytes(slice, ASF_OBJECT_HEADER_SIZE + ASF_DATA_OBJECT_FIELDS_SIZE);
		if (!guidEquals(bytes, 0, ASF_DATA_OBJECT)) {
			throw new Error('Invalid ASF file: no Data Object after the Header Object.');
		}
		const view = toView(bytes);
		const dataObjectSize = getUint64Le(view, 16);
		const declaredPacketCount = getUint64Le(view, 40);
		this.firstPacketPosition = headerSize + ASF_OBJECT_HEADER_SIZE + ASF_DATA_OBJECT_FIELDS_SIZE;

		// A broadcast's sizes are not yet known; a file's are, though it may be cut short of them
		const broadcast = (this.flags & ASF_BROADCAST_FLAG) !== 0;
		const fileSize = this.reader.fileSizeNonStrict;
		let dataEnd = !broadcast && dataObjectSize >= ASF_OBJECT_HEADER_SIZE + ASF_DATA_OBJECT_FIELDS_SIZE
			? headerSize + dataObjectSize
			: fileSize ?? Infinity;
		this.dataObjectEnd = dataEnd;
		if (fileSize !== null) {
			dataEnd = Math.min(dataEnd, fileSize);
		}

		let packetCount = Math.ceil(Math.max(dataEnd - this.firstPacketPosition, 0) / this.packetSize);
		if (!broadcast && declaredPacketCount > 0) {
			packetCount = Math.min(packetCount, declaredPacketCount);
		}
		if (!Number.isFinite(packetCount)) {
			throw new Error('Unsupported ASF file: the data packets have no end.');
		}
		this.packetCount = packetCount;
	}

	/** Reads and parses a data packet, as FFmpeg's asf_get_packet and asf_read_frame_header do; null if unreadable. */
	private getDataPacket(packetIndex: number): Promise<DataPacket | null> {
		let packet = this.dataPackets.get(packetIndex);
		if (!packet) {
			packet = this.readDataPacket(packetIndex);
			if (this.dataPackets.size >= DATA_PACKET_CACHE_SIZE) {
				this.dataPackets.delete(this.dataPackets.keys().next().value!);
			}
			this.dataPackets.set(packetIndex, packet);
		}
		return packet;
	}

	private async readDataPacket(packetIndex: number): Promise<DataPacket | null> {
		if (packetIndex < 0 || packetIndex >= this.packetCount) {
			return null;
		}

		const position = this.firstPacketPosition + packetIndex * this.packetSize;
		const fileSize = this.reader.fileSizeNonStrict;
		// A file cut short ends in a partial packet, whose whole payloads are still read
		const length = fileSize === null ? this.packetSize : Math.min(this.packetSize, fileSize - position);
		if (length < MIN_PACKET_HEADER_SIZE) {
			return null;
		}
		const slice = await this.reader.requestSlice(position, length);
		if (!slice) {
			return null;
		}
		const bytes = readBytes(slice, length);
		const view = toView(bytes);

		const payloads: Payload[] = [];
		let sendTime = 0;
		try {
			let offset = 0;
			let lengthTypeFlags = view.getUint8(offset++);
			if (lengthTypeFlags & 0x80) {
				// Error correction data, whose length its flags give when its length type is zero
				if (!(lengthTypeFlags & 0x60)) {
					offset += lengthTypeFlags & 0x0f;
				}
				lengthTypeFlags = view.getUint8(offset++);
			}
			const propertyFlags = view.getUint8(offset++);

			const packetLengthField = readVariableField(view, offset, lengthTypeFlags >> 5);
			offset += packetLengthField.size;
			const packetLength = packetLengthField.size > 0 ? packetLengthField.value : this.packetSize;
			offset += readVariableField(view, offset, lengthTypeFlags >> 1).size; // The sequence, unused
			const paddingField = readVariableField(view, offset, lengthTypeFlags >> 3);
			offset += paddingField.size;
			sendTime = view.getUint32(offset, true);
			offset += 6; // The send time and the duration

			if (packetLength === 0 || packetLength > this.packetSize || paddingField.value >= packetLength) {
				return { sendTime, payloads };
			}

			// The payload data ends before the padding; a payload of a multiple payload packet may still reach into
			// the padding, and so to the end of the packet, as FFmpeg allows
			const declaredPayloadEnd = packetLength - paddingField.value;
			const singlePayloadEnd = Math.min(declaredPayloadEnd, bytes.length);
			const multiplePayloads = (lengthTypeFlags & 0x01) !== 0;
			let payloadCount = 1;
			let payloadLengthType = 0;
			if (multiplePayloads) {
				const payloadFlags = view.getUint8(offset++);
				payloadCount = payloadFlags & 0x3f;
				payloadLengthType = payloadFlags >> 6;
			}

			for (let i = 0; i < payloadCount; i++) {
				const streamByte = view.getUint8(offset++);
				const objectNumberField = readVariableField(view, offset, propertyFlags >> 4);
				offset += objectNumberField.size;
				const offsetField = readVariableField(view, offset, propertyFlags >> 2);
				offset += offsetField.size;
				const replicatedLengthField = readVariableField(view, offset, propertyFlags);
				offset += replicatedLengthField.size;
				const replicatedLength = replicatedLengthField.value;

				let objectSize = 0;
				let presentationTime = 0;
				let timeDelta = 0;
				const compressed = replicatedLength === 1;
				if (replicatedLength >= 8) {
					objectSize = view.getUint32(offset, true);
					presentationTime = view.getUint32(offset + 4, true);
				} else if (compressed) {
					// The offset field holds the presentation time, and the replicated byte its step
					presentationTime = offsetField.value;
					timeDelta = view.getUint8(offset);
				} else {
					break; // A payload without its media object's size cannot be placed
				}
				offset += replicatedLength;

				let payloadLength: number;
				let truncated = false;
				if (multiplePayloads) {
					const payloadLengthField = readVariableField(view, offset, payloadLengthType);
					offset += payloadLengthField.size;
					payloadLength = payloadLengthField.value;
					if (offset + payloadLength > bytes.length) {
						payloadLength = bytes.length - offset;
						truncated = true;
					}
				} else {
					payloadLength = singlePayloadEnd - offset;
					truncated = declaredPayloadEnd > bytes.length;
					if (payloadLength < 0) {
						break;
					}
				}

				const streamNumber = streamByte & 0x7f;
				const isKey = (streamByte & 0x80) !== 0;
				if (compressed && !truncated) {
					// Sub-payloads, each a whole media object after its one-byte size
					const end = offset + payloadLength;
					let subPosition = offset;
					let subIndex = 0;
					while (subPosition < end && payloads.length < PAYLOADS_PER_PACKET_LIMIT) {
						const subSize = view.getUint8(subPosition++);
						if (subSize === 0 || subPosition + subSize > end) {
							break;
						}
						payloads.push({
							streamNumber,
							isKey,
							objectNumber: (objectNumberField.value + subIndex) & 0xff,
							offset: 0,
							objectSize: subSize,
							presentationTime: presentationTime + subIndex * timeDelta,
							position: position + subPosition,
							length: subSize,
							truncated: false,
						});
						subPosition += subSize;
						subIndex++;
					}
				} else if (!compressed) {
					payloads.push({
						streamNumber,
						isKey,
						objectNumber: objectNumberField.value,
						offset: offsetField.value,
						objectSize,
						presentationTime,
						position: position + offset,
						length: payloadLength,
						truncated,
					});
				}
				offset += payloadLength;
				if (truncated || payloads.length >= PAYLOADS_PER_PACKET_LIMIT) {
					break;
				}
			}
		} catch (error) {
			// A packet cut short keeps the payloads read before its end
			if (!(error instanceof RangeError)) {
				throw error;
			}
		}

		if (payloads.length > PAYLOADS_PER_PACKET_LIMIT) {
			payloads.length = PAYLOADS_PER_PACKET_LIMIT;
		}
		return { sendTime, payloads };
	}

	/**
	 * Finds the first payload at or after a location that starts a media object of a stream, and whose media object
	 * the data packets hold, before a data packet; null when there is none. A media object whose fragments are missing
	 * is passed over, as FFmpeg drops an incomplete one.
	 */
	async findNextObject(
		stream: StreamInfo,
		packetIndex: number,
		ordinal: number,
		keyOnly: boolean,
		packetEnd = this.packetCount,
	): Promise<MediaObject | null> {
		for (let index = packetIndex; index < Math.min(packetEnd, this.packetCount); index++) {
			const packet = await this.getDataPacket(index);
			if (!packet) {
				continue;
			}
			for (let i = index === packetIndex ? ordinal : 0; i < packet.payloads.length; i++) {
				const payload = packet.payloads[i]!;
				if (payload.streamNumber !== stream.number || payload.offset !== 0) {
					continue;
				}
				if (keyOnly && !payload.isKey) {
					continue;
				}
				const location = { packetIndex: index, ordinal: i, payload };
				const object = await this.collectFragments(location);
				if (object) {
					return object;
				}
			}
		}
		return null;
	}

	/**
	 * Collects a media object's fragments from its first payload on; null when the data packets lack any of them.
	 * Where the file ends within a fragment, the object ends with it, as FFmpeg shrinks a packet its read cuts short.
	 */
	private async collectFragments(location: PayloadLocation): Promise<MediaObject | null> {
		const first = location.payload;
		// FFmpeg refuses a media object of 16 MiB or more, as no frame it reads is one
		if (first.objectSize === 0 || first.objectSize >= MAX_MEDIA_OBJECT_SIZE || first.length > first.objectSize) {
			return null;
		}
		const fragments = [first];
		let received = first.length;
		if (received === first.objectSize || first.truncated) {
			return first.length > 0 ? { location, fragments, size: first.length } : null;
		}

		const packetLimit = Math.min(
			this.packetCount,
			location.packetIndex + 1 + 2 * Math.ceil(first.objectSize / this.packetSize) + OBJECT_FRAGMENT_PACKET_SLACK,
		);
		for (let index = location.packetIndex; index < packetLimit; index++) {
			const packet = await this.getDataPacket(index);
			if (!packet) {
				return null;
			}
			for (let i = index === location.packetIndex ? location.ordinal + 1 : 0; i < packet.payloads.length; i++) {
				const payload = packet.payloads[i]!;
				if (payload.streamNumber !== first.streamNumber) {
					continue;
				}
				// The stream moving on to another media object leaves this one incomplete, and so does a fragment that
				// does not continue where the received bytes end
				if (payload.offset !== received || payload.objectNumber !== first.objectNumber) {
					return null;
				}
				if (payload.offset + payload.length > first.objectSize) {
					return null;
				}
				fragments.push(payload);
				received += payload.length;
				if (payload.truncated) {
					return { location, fragments, size: received };
				}
				if (received >= first.objectSize) {
					return received === first.objectSize ? { location, fragments, size: first.objectSize } : null;
				}
			}
		}
		return null;
	}

	/** Reads a media object's data from its fragments, descrambled when its stream spreads its audio. */
	async readMediaObject(object: MediaObject, stream: StreamInfo): Promise<Uint8Array | null> {
		const { fragments, size: objectSize } = object;

		let data: Uint8Array;
		if (fragments.length === 1) {
			const slice = await this.reader.requestSlice(fragments[0]!.position, objectSize);
			if (!slice) {
				return null;
			}
			data = readBytes(slice, objectSize);
		} else {
			data = new Uint8Array(objectSize);
			for (const fragment of fragments) {
				const slice = await this.reader.requestSlice(fragment.position, fragment.length);
				if (!slice) {
					return null;
				}
				if (fragment.offset < objectSize) {
					const fragmentData = readBytes(slice, fragment.length);
					data.set(fragmentData.subarray(0, objectSize - fragment.offset), fragment.offset);
				}
			}
		}

		return stream.spread ? descramble(data, stream.spread) : data;
	}

	/**
	 * Finds the last media object of a stream whose timestamp is at most a time, in decode order, or the last key
	 * one. A video key frame search starts from the index entry at the time when the file has an index. Otherwise,
	 * since a media object is sent no later than it is presented, the last such object starts in a data packet sent
	 * by the time: the search bisects the data packets by send time, then reads back from there in growing windows.
	 */
	async findLastObject(stream: StreamInfo, timestamp: number, keyOnly: boolean): Promise<MediaObject | null> {
		const target = timestamp * 1000 + this.preroll;

		if (keyOnly) {
			await (this.indexPromise ??= this.readIndexes());
			const index = stream.keyFrameIndex;
			if (index && index.packetIndices.length > 0 && Number.isFinite(target)) {
				const lastEntry = index.packetIndices.length - 1;
				const entry = Math.min(Math.max(Math.floor(target / index.interval), 0), lastEntry);
				const found = await this.findLastObjectFrom(stream, index.packetIndices[entry]!, target, keyOnly);
				if (found) {
					return found;
				}
			}
		}

		const lastSentPacket = await this.findLastPacketSentBy(target);
		let windowStart = Math.max(lastSentPacket - INITIAL_SEARCH_WINDOW + 1, 0);
		let windowEnd = this.packetCount;
		let windowSize = INITIAL_SEARCH_WINDOW;
		while (true) {
			const found = await this.findLastObjectFrom(stream, windowStart, target, keyOnly, windowEnd);
			if (found || windowStart === 0) {
				return found;
			}
			windowEnd = windowStart;
			windowSize *= 2;
			windowStart = Math.max(windowStart - windowSize, 0);
		}
	}

	/**
	 * Returns the last media object starting in the data packets from one on, before an end, whose presentation time
	 * is at most a target; the search stops at the first object past the target, as objects are in decode order.
	 */
	private async findLastObjectFrom(
		stream: StreamInfo,
		packetIndex: number,
		target: number,
		keyOnly: boolean,
		packetEnd = this.packetCount,
	): Promise<MediaObject | null> {
		let found: MediaObject | null = null;
		let object = await this.findNextObject(stream, packetIndex, 0, false, packetEnd);
		while (object && object.location.payload.presentationTime <= target) {
			if (!keyOnly || stream.type === 'audio' || object.location.payload.isKey) {
				found = object;
			}
			const { location } = object;
			object = await this.findNextObject(stream, location.packetIndex, location.ordinal + 1, false, packetEnd);
		}
		return found;
	}

	/** Bisects the data packets for the last one sent by a time, as their send times rise; 0 when none is. */
	private async findLastPacketSentBy(time: number) {
		if (time === Infinity) {
			return this.packetCount - 1;
		}
		let low = 0;
		let high = this.packetCount - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const packet = await this.getDataPacket(middle);
			if (packet && packet.sendTime <= time) {
				low = middle;
			} else {
				high = middle - 1;
			}
		}
		return low;
	}

	/**
	 * Reads the index objects after the Data Object: a Simple Index Object for each video stream, in header order, and
	 * an Index Object's entries for the streams it specifies. Each entry locates the data packet in which a stream's
	 * key frame at or before its time starts.
	 */
	private async readIndexes() {
		const videoStreams = [...this.streams.values()].filter(stream => stream.type === 'video');
		let simpleIndexCount = 0;
		let position = this.dataObjectEnd;
		const fileSize = this.reader.fileSizeNonStrict;

		for (let i = 0; i < MAX_TRAILING_OBJECTS && Number.isFinite(position); i++) {
			if (fileSize !== null && position + ASF_OBJECT_HEADER_SIZE > fileSize) {
				break;
			}
			const headerSlice = await this.reader.requestSlice(position, ASF_OBJECT_HEADER_SIZE);
			if (!headerSlice) {
				break;
			}
			const objectHeader = readBytes(headerSlice, ASF_OBJECT_HEADER_SIZE);
			const size = getUint64Le(toView(objectHeader), 16);
			if (size < ASF_OBJECT_HEADER_SIZE) {
				break;
			}

			const isSimpleIndex = guidEquals(objectHeader, 0, ASF_SIMPLE_INDEX_OBJECT);
			const isIndex = guidEquals(objectHeader, 0, ASF_INDEX_OBJECT);
			if ((isSimpleIndex || isIndex) && size <= MAX_INDEX_OBJECT_SIZE) {
				const slice = await this.reader.requestSlice(position, size);
				if (!slice) {
					break;
				}
				const object = readBytes(slice, size);
				try {
					if (isSimpleIndex) {
						const stream = videoStreams[simpleIndexCount++];
						if (stream) {
							stream.keyFrameIndex = this.readSimpleIndex(object);
						}
					} else {
						this.readIndex(object);
					}
				} catch (error) {
					if (!(error instanceof RangeError)) {
						throw error;
					}
				}
			}

			position += size;
		}
	}

	private readSimpleIndex(object: Uint8Array): KeyFrameIndex {
		const view = toView(object);
		// The file ID precedes the interval, in 100-nanosecond units
		const interval = getUint64Le(view, ASF_OBJECT_HEADER_SIZE + 16) / 10000;
		const count = view.getUint32(ASF_OBJECT_HEADER_SIZE + 28, true);
		const packetIndices: number[] = [];
		for (let i = 0; i < count; i++) {
			packetIndices.push(view.getUint32(ASF_OBJECT_HEADER_SIZE + 32 + i * 6, true));
		}
		return { interval: interval > 0 ? interval : 1000, packetIndices };
	}

	private readIndex(object: Uint8Array) {
		const view = toView(object);
		const interval = view.getUint32(ASF_OBJECT_HEADER_SIZE, true);
		const specifierCount = view.getUint16(ASF_OBJECT_HEADER_SIZE + 4, true);
		const blockCount = view.getUint32(ASF_OBJECT_HEADER_SIZE + 6, true);
		if (specifierCount === 0) {
			return;
		}
		let position = ASF_OBJECT_HEADER_SIZE + 10;
		const specifiedStreams: (StreamInfo | undefined)[] = [];
		for (let i = 0; i < specifierCount; i++) {
			specifiedStreams.push(this.streams.get(view.getUint16(position, true) & 0x7f));
			position += 4;
		}
		const indices = specifiedStreams.map(() => [] as number[]);

		for (let block = 0; block < blockCount; block++) {
			const entryCount = view.getUint32(position, true);
			position += 4;
			// A block of more entries than the object holds is malformed, and ends the index
			if (position + specifierCount * 8 + entryCount * specifierCount * 4 > object.length) {
				break;
			}
			// Each block's positions count from the first data packet, and its entries from the block's position
			const blockPositions = specifiedStreams.map((_, i) => getUint64Le(view, position + i * 8));
			position += specifierCount * 8;
			for (let entry = 0; entry < entryCount; entry++) {
				for (let i = 0; i < specifierCount; i++) {
					const offset = blockPositions[i]! + view.getUint32(position, true);
					indices[i]!.push(Math.floor(offset / this.packetSize));
					position += 4;
				}
			}
		}

		specifiedStreams.forEach((stream, i) => {
			if (stream && stream.type === 'video' && !stream.keyFrameIndex) {
				stream.keyFrameIndex = { interval: interval > 0 ? interval : 1000, packetIndices: indices[i]! };
			}
		});
	}
}
