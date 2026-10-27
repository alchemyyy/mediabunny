/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from './output';
import { MediaCodec } from './codec';
import { DurationMetadataRequestOptions } from './demuxer';
import { Input } from './input';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
} from './input-track';
import {
	arrayCount,
	assert,
	isThenable,
	MaybePromise,
	MaybeRelevantPromise,
	ResultValue,
	roundToDivisor,
} from './misc';
import { EncodedPacket, PacketRetrievalOptions, PacketRetrievalResult } from './packet';

export type SegmentedInputMetadata = {
	name: string | null;
	bitrate: number | null; // doc block: this refers to the _peak_ bitrate
	averageBitrate: number | null;
	codecs: MediaCodec[];
	codecStrings: string[];
	resolution: { width: number; height: number } | null;
	frameRate: number | null;
	isKeyFrameOnly: boolean;
};

export type AssociatedGroup = {
	id: string;
	type: 'video' | 'audio' | 'subtitles' | 'closed-captions';
};

export type Segment = {
	timestamp: number;
	duration: number;
	/**
	 * The Unix time (in seconds) corresponding to this segment's start timestamp, or null if unknown. This is computed
	 * whenever the source provides wall-clock information (e.g. HLS program date time), even if the segment timestamps
	 * themselves are not shifted into Unix time space.
	 */
	unixEpochTimestamp: number | null;
	firstSegment: Segment | null;
};

export type SegmentRetrievalOptions = {
	skipLiveWait?: boolean;
};

export class SegmentRetrievalResult {
	segment: Segment | null;
	provisional = false;

	constructor(segment: Segment | null) {
		this.segment = segment;
	}
}

export type SegmentedInputTrackDeclaration = {
	id: number;
	type: TrackType;
};

export abstract class SegmentedInput {
	input: Input;
	path: string;
	trackDeclarations: SegmentedInputTrackDeclaration[] | null;

	nextInputCacheAge = 0;
	inputCache: {
		segment: Segment;
		input: Input;
		age: number;
	}[] = [];

	trackBackingsPromise: Promise<InputTrackBacking[]> | null = null;
	firstSegment: Segment | null = null;
	firstSegmentFirstTimestamps = new WeakMap<Segment, number>();

	constructor(input: Input, path: string, trackDeclarations: SegmentedInputTrackDeclaration[] | null) {
		this.input = input;
		this.path = path;
		this.trackDeclarations = trackDeclarations;
	}

	abstract getFirstSegment(
		res: ResultValue<SegmentRetrievalResult>,
		options: SegmentRetrievalOptions,
	): MaybeRelevantPromise;
	abstract getSegmentAt(
		res: ResultValue<SegmentRetrievalResult>,
		timestamp: number,
		options: SegmentRetrievalOptions,
	): MaybeRelevantPromise;
	abstract getNextSegment(
		res: ResultValue<SegmentRetrievalResult>,
		segment: Segment,
		options: SegmentRetrievalOptions,
	): MaybeRelevantPromise;
	abstract getPreviousSegment(
		res: ResultValue<SegmentRetrievalResult>,
		segment: Segment,
		options: SegmentRetrievalOptions,
	): MaybeRelevantPromise;
	abstract getInputForSegment(segment: Segment): Input;

	abstract getLiveRefreshInterval(): Promise<number | null>;

	async getDurationFromMetadata(options: DurationMetadataRequestOptions) {
		const segmentResult = new ResultValue<SegmentRetrievalResult>();
		const promise = this.getSegmentAt(segmentResult, Infinity, {
			skipLiveWait: options.skipLiveWait,
		});
		if (segmentResult.pending) await promise;

		const lastSegment = segmentResult.value.segment;
		if (!lastSegment) {
			return null;
		}

		return lastSegment.timestamp + lastSegment.duration;
	}

	async getUnixTimeForTimestamp(timestamp: number): Promise<number | null> {
		const segmentResult = new ResultValue<SegmentRetrievalResult>();
		const promise = this.getSegmentAt(segmentResult, timestamp, {});
		if (segmentResult.pending) await promise;

		let segment = segmentResult.value.segment;
		if (!segment) {
			// Default to the first segment
			segmentResult.reset();
			const promise = this.getFirstSegment(segmentResult, {});
			if (segmentResult.pending) await promise;

			segment = segmentResult.value.segment;
		}

		if (!segment || segment.unixEpochTimestamp === null) {
			return null;
		}

		const elapsed = timestamp - segment.timestamp;
		return segment.unixEpochTimestamp + elapsed;
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		return this.trackBackingsPromise ??= (async () => {
			const backings: InputTrackBacking[] = [];

			if (this.trackDeclarations) {
				for (const decl of this.trackDeclarations) {
					if (decl.type === 'video') {
						const number = arrayCount(backings, x => x.getType() === 'video') + 1;

						backings.push(
							new SegmentedInputInputVideoTrackBacking(this, decl, number),
						);
					} else if (decl.type === 'audio') {
						const number = arrayCount(backings, x => x.getType() === 'audio') + 1;

						backings.push(
							new SegmentedInputInputAudioTrackBacking(this, decl, number),
						);
					}
				}
			} else {
				// There are no declarations, we must determine the tracks from the first segment
				const firstSegmentResult = new ResultValue<SegmentRetrievalResult>();
				const promise = this.getFirstSegment(firstSegmentResult, {});
				if (firstSegmentResult.pending) await promise;

				this.firstSegment = firstSegmentResult.value.segment;
				if (!this.firstSegment) {
					return [];
				}

				const input = this.getInputForSegment(this.firstSegment);
				const inputTracks = await input.getTracks();

				for (const track of inputTracks) {
					if (track.type === 'video') {
						const number = arrayCount(backings, x => x.getType() === 'video') + 1;

						backings.push(
							new SegmentedInputInputVideoTrackBacking(this, {
								id: backings.length + 1,
								type: 'video',
							}, number),
						);
					} else if (track.type === 'audio') {
						const number = arrayCount(backings, x => x.getType() === 'audio') + 1;

						backings.push(
							new SegmentedInputInputAudioTrackBacking(this, {
								id: backings.length + 1,
								type: 'audio',
							}, number),
						);
					}
				}
			}

			return backings;
		})();
	}

	async getMediaOffset(res: ResultValue<number>, segment: Segment, input: Input): MaybeRelevantPromise {
		const format = input._format ?? await input.getFormat();
		if (!format.supportsTimestampedMediaData) {
			return res.set(segment.timestamp);
		}

		// The segments' timestamps are assumed to lie on one shared timeline (until the next discontinuity), which we
		// align to the playlist using the first segment
		const firstSegment = segment.firstSegment ?? segment;

		let firstSegmentFirstTimestamp = this.firstSegmentFirstTimestamps.get(firstSegment);
		if (firstSegmentFirstTimestamp === undefined) {
			const firstInput = this.getInputForSegment(firstSegment);
			firstSegmentFirstTimestamp = await firstInput.getFirstTimestamp();
			this.firstSegmentFirstTimestamps.set(firstSegment, firstSegmentFirstTimestamp);
		}

		return res.set(firstSegment.timestamp - firstSegmentFirstTimestamp);
	}

	dispose() {
		for (const entry of this.inputCache) {
			entry.input.dispose();
		}
		this.inputCache.length = 0;
	}
}

type PacketInfo = {
	segment: Segment;
	track: InputTrack;
	sourcePacket: EncodedPacket;
};

class SegmentedInputInputTrackBacking implements InputTrackBacking {
	segmentedInput: SegmentedInput;
	decl: SegmentedInputTrackDeclaration;
	number: number;

	hydrationPromise: Promise<void> | null = null;
	firstInputTrack: InputTrack | null = null;
	firstSegment: Segment | null = null;

	constructor(segmentedInput: SegmentedInput, decl: SegmentedInputTrackDeclaration, number: number) {
		this.segmentedInput = segmentedInput;
		this.decl = decl;
		this.number = number;
	}

	hydrate() {
		return this.hydrationPromise ??= (async () => {
			if (!this.segmentedInput.firstSegment) {
				const firstSegmentResult = new ResultValue<SegmentRetrievalResult>();
				const promise = this.segmentedInput.getFirstSegment(firstSegmentResult, {});
				if (firstSegmentResult.pending) await promise;

				this.segmentedInput.firstSegment = firstSegmentResult.value.segment;
			}

			if (!this.segmentedInput.firstSegment) {
				throw new Error('Missing first segment, can\'t retrieve track.');
			}

			let currentSegment: Segment | null = this.segmentedInput.firstSegment;
			let track: InputTrack | null = null;
			const segmentResult = new ResultValue<SegmentRetrievalResult>();

			// For playlists with sparse tracks (rare af!!), not every segment has every track, so we need to loop to
			// find the first segment that actually contains the track we want.
			while (currentSegment) {
				const input = this.segmentedInput.getInputForSegment(currentSegment);
				const inputTracks = await input.getTracks();
				track = inputTracks.find(x => x.type === this.decl.type && x.number === this.number) ?? null;

				if (track) {
					break;
				}

				segmentResult.reset();
				const promise = this.segmentedInput.getNextSegment(segmentResult, currentSegment, {});
				if (segmentResult.pending) await promise;

				currentSegment = segmentResult.value.segment;
			}

			if (!track) {
				throw new Error('No matching track found in underlying media data.');
			}

			this.firstInputTrack = track;
			this.firstSegment = currentSegment;
		})();
	}

	getId(): number {
		return this.decl.id;
	}

	getType(): TrackType {
		return this.decl.type;
	}

	getNumber(): number {
		return this.number;
	}

	/** If the backing track is already present, delegate synchronously; otherwise, hydrate first. */
	delegate<T>(fn: () => MaybePromise<T>): MaybePromise<T> {
		if (this.firstInputTrack) {
			return fn();
		}

		return this.hydrate().then(fn);
	}

	async getDecoderConfig() {
		return this.delegate(() => this.firstInputTrack!._backing.getDecoderConfig());
	}

	getHasOnlyKeyPackets() {
		return this.delegate(() => this.firstInputTrack!._backing.getHasOnlyKeyPackets?.() ?? null);
	}

	getPairingMask() {
		return 1n;
	}

	getCodec() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodec());
	}

	getInternalCodecId() {
		return this.delegate(() => this.firstInputTrack!._backing.getInternalCodecId());
	}

	getDisposition() {
		return this.delegate(() => this.firstInputTrack!._backing.getDisposition());
	}

	getLanguageCode() {
		return this.delegate(() => this.firstInputTrack!._backing.getLanguageCode());
	}

	getName() {
		return this.delegate(() => this.firstInputTrack!._backing.getName());
	}

	getTimeResolution() {
		return this.delegate(() => this.firstInputTrack!._backing.getTimeResolution());
	}

	async isRelativeToUnixEpoch() {
		await this.hydrate();

		assert(this.segmentedInput.firstSegment);
		return this.segmentedInput.firstSegment.unixEpochTimestamp === this.segmentedInput.firstSegment.timestamp;
	}

	getUnixTimeForTimestamp(timestamp: number) {
		return this.segmentedInput.getUnixTimeForTimestamp(timestamp);
	}

	getBitrate() {
		return this.delegate(() => this.firstInputTrack!._backing.getBitrate());
	}

	getAverageBitrate() {
		return this.delegate(() => this.firstInputTrack!._backing.getAverageBitrate());
	}

	getUnsupportedFeatures() {
		return this.delegate(() => this.firstInputTrack!.getUnsupportedFeatures());
	}

	getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		return this.segmentedInput.getDurationFromMetadata(options);
	}

	getLiveRefreshInterval(): Promise<number | null> {
		return this.segmentedInput.getLiveRefreshInterval();
	}

	async createAdjustedPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		segment: Segment,
		track: InputTrack,
		provisional: boolean,
	): MaybeRelevantPromise {
		assert(packet.sequenceNumber >= 0);
		assert(this.segmentedInput.firstSegment);

		const mediaOffsetResult = new ResultValue<number>();
		const mediaOffsetPromise = this.segmentedInput.getMediaOffset(mediaOffsetResult, segment, track.input);
		if (mediaOffsetResult.pending) await mediaOffsetPromise;

		const mediaOffset = mediaOffsetResult.value;
		// If we didn't do this then sequence numbers would exceed Number.MAX_SAFE_INTEGER for Unix-timestamped segments
		const segmentTimestampRelativeToFirst = segment.timestamp - this.segmentedInput.firstSegment.timestamp;

		let timeResolution = track._backing.getTimeResolution();
		if (isThenable(timeResolution)) timeResolution = await timeResolution;

		const modified = packet.clone({
			timestamp: roundToDivisor(
				packet.timestamp + mediaOffset,
				timeResolution,
			),
			// The 1e8 assumes a max of 100 MB per second, highly unlikely to be hit, so this should guarantee
			// monotonically increasing sequence numbers across segments.
			sequenceNumber: Math.floor(1e8 * segmentTimestampRelativeToFirst) + packet.sequenceNumber,
		});

		// Replaces the inner packet's internal data the clone carried over; it stays reachable via sourcePacket
		modified._internal = {
			segment,
			track,
			sourcePacket: packet,
		} satisfies PacketInfo;

		const result = new PacketRetrievalResult(modified);
		result.provisional = provisional;

		return res.set(result);
	}

	async getFirstPacket(
		res: ResultValue<PacketRetrievalResult>,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (!this.firstInputTrack) {
			await this.hydrate();
		}

		assert(this.firstInputTrack);
		assert(this.firstSegment);

		let currentTrack: InputTrack | null = this.firstInputTrack;
		let currentSegment: Segment | null = this.firstSegment;
		const packetResult = new ResultValue<PacketRetrievalResult>();
		const segmentResult = new ResultValue<SegmentRetrievalResult>();

		// Loop until we found a segment with a packet (segments may contain zero packets in rare cases)
		while (true) {
			if (currentTrack) {
				packetResult.reset();
				const promise = currentTrack._backing.getFirstPacket(packetResult, options);
				if (packetResult.pending) await promise;

				const packet = packetResult.value.packet;
				if (packet) {
					return this.createAdjustedPacket(res, packet, currentSegment, currentTrack, false);
				}
			}

			segmentResult.reset();
			const segmentPromise = this.segmentedInput.getNextSegment(segmentResult, currentSegment, {
				skipLiveWait: options.skipLiveWait,
			});
			if (segmentResult.pending) await segmentPromise;

			currentSegment = segmentResult.value.segment;
			if (!currentSegment) {
				break;
			}

			const nextInput = this.segmentedInput.getInputForSegment(currentSegment);
			let nextTracks = getTracksMaybeSync(nextInput);
			if (isThenable(nextTracks)) nextTracks = await nextTracks;

			currentTrack = nextTracks.find(t => (
				t.type === this.firstInputTrack!.type && t.number === this.firstInputTrack!.number
			)) ?? null;
		}

		const result = new PacketRetrievalResult(null);
		result.provisional = segmentResult.value.provisional;

		return res.set(result);
	}

	getNextPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getNextInternal(res, packet, options, false);
	}

	getNextKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getNextInternal(res, packet, options, true);
	}

	async _getNextInternal(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): MaybeRelevantPromise {
		const info = packet._internal as PacketInfo | undefined;
		assert(info);

		const packetResult = new ResultValue<PacketRetrievalResult>();
		const promise = keyframesOnly
			? info.track._backing.getNextKeyPacket(packetResult, info.sourcePacket, options)
			: info.track._backing.getNextPacket(packetResult, info.sourcePacket, options);
		if (packetResult.pending) await promise;

		const nextPacket = packetResult.value.packet;

		if (nextPacket) {
			return this.createAdjustedPacket(res, nextPacket, info.segment, info.track, false);
		}

		let currentSegment: Segment | null = info.segment;
		const segmentResult = new ResultValue<SegmentRetrievalResult>();

		while (true) {
			segmentResult.reset();
			const segmentPromise = this.segmentedInput.getNextSegment(segmentResult, currentSegment, {
				skipLiveWait: options.skipLiveWait,
			});
			if (segmentResult.pending) await segmentPromise;

			const nextSegment = segmentResult.value.segment;
			if (!nextSegment) {
				const result = new PacketRetrievalResult(null);
				result.provisional = segmentResult.value.provisional;

				return res.set(result);
			}

			const nextInput = this.segmentedInput.getInputForSegment(nextSegment);
			let nextTracks = getTracksMaybeSync(nextInput);
			if (isThenable(nextTracks)) nextTracks = await nextTracks;

			const nextTrack = nextTracks.find(t => t.type === info.track.type && t.number === info.track.number);

			if (!nextTrack) {
				currentSegment = nextSegment;
				continue;
			}

			packetResult.reset();
			const promise = nextTrack._backing.getFirstPacket(packetResult, options);
			if (packetResult.pending) await promise;

			let firstPacket = packetResult.value.packet;
			if (firstPacket && keyframesOnly && firstPacket.type !== 'key') {
				packetResult.reset();
				const keyPromise = nextTrack._backing.getNextKeyPacket(packetResult, firstPacket, options);
				if (packetResult.pending) await keyPromise;

				firstPacket = packetResult.value.packet;
			}

			if (!firstPacket) {
				// Segments may contain zero packets for a track, so, move on
				currentSegment = nextSegment;
				continue;
			}

			return this.createAdjustedPacket(res, firstPacket, nextSegment, nextTrack, false);
		}
	}

	getPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getPacketInternal(res, timestamp, options, false);
	}

	getKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getPacketInternal(res, timestamp, options, true);
	}

	async _getPacketInternal(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): MaybeRelevantPromise {
		const segmentResult = new ResultValue<SegmentRetrievalResult>();
		const segmentPromise = this.segmentedInput.getSegmentAt(segmentResult, timestamp, {
			skipLiveWait: options.skipLiveWait,
		});
		if (segmentResult.pending) await segmentPromise;

		// If the segment lookup is provisional, then so is anything we derive from it
		let provisional = segmentResult.value.provisional;

		let currentSegment = segmentResult.value.segment;
		if (!currentSegment) {
			const result = new PacketRetrievalResult(null);
			result.provisional = provisional;

			return res.set(result);
		}

		if (!this.firstInputTrack) {
			await this.hydrate();
		}

		const packetResult = new ResultValue<PacketRetrievalResult>();
		const mediaOffsetResult = new ResultValue<number>();

		while (currentSegment) {
			const input = this.segmentedInput.getInputForSegment(currentSegment);
			let tracks = getTracksMaybeSync(input);
			if (isThenable(tracks)) tracks = await tracks;

			const track = tracks.find(t => (
				t.type === this.firstInputTrack!.type && t.number === this.firstInputTrack!.number
			));

			if (!track) {
				// Search the previous segment
				segmentResult.reset();
				const prevSegmentPromise = this.segmentedInput.getPreviousSegment(segmentResult, currentSegment, {
					skipLiveWait: options.skipLiveWait,
				});
				if (segmentResult.pending) await prevSegmentPromise;

				currentSegment = segmentResult.value.segment;
				continue;
			}

			mediaOffsetResult.reset();
			const mediaOffsetPromise = this.segmentedInput.getMediaOffset(mediaOffsetResult, currentSegment, input);
			if (mediaOffsetResult.pending) await mediaOffsetPromise;

			const offsetTimestamp = timestamp - mediaOffsetResult.value;

			packetResult.reset();
			const packetPromise = keyframesOnly
				? track._backing.getKeyPacket(packetResult, offsetTimestamp, options)
				: track._backing.getPacket(packetResult, offsetTimestamp, options);
			if (packetResult.pending) await packetPromise;

			const packet = packetResult.value.packet;
			if (!packet) {
				// Search the previous segment
				segmentResult.reset();
				const prevSegmentPromise = this.segmentedInput.getPreviousSegment(segmentResult, currentSegment, {
					skipLiveWait: options.skipLiveWait,
				});
				if (segmentResult.pending) await prevSegmentPromise;

				currentSegment = segmentResult.value.segment;
				continue;
			}

			// The playlist may claim the segment to be longer than its media actually is, in which case the timestamp
			// can lie in the next segment instead. That's only possible if it lies past this segment's media.
			let lastPacket: EncodedPacket | null = packet;
			if (keyframesOnly) {
				packetResult.reset();
				const lastPacketPromise = track._backing.getPacket(
					packetResult,
					offsetTimestamp,
					{ ...options, metadataOnly: true },
				);
				if (packetResult.pending) await lastPacketPromise;

				lastPacket = packetResult.value.packet;
			}
			assert(lastPacket);

			if (offsetTimestamp >= lastPacket.timestamp + lastPacket.duration) {
				segmentResult.reset();
				const nextSegmentPromise = this.segmentedInput.getNextSegment(segmentResult, currentSegment, {
					skipLiveWait: options.skipLiveWait,
				});
				if (segmentResult.pending) await nextSegmentPromise;

				// A next segment that may still come could hold the timestamp, so the answer may change
				provisional ||= segmentResult.value.provisional;

				const nextSegment = segmentResult.value.segment;
				if (nextSegment) {
					const nextInput = this.segmentedInput.getInputForSegment(nextSegment);
					let nextTracks = getTracksMaybeSync(nextInput);
					if (isThenable(nextTracks)) nextTracks = await nextTracks;

					const nextTrack = nextTracks.find(t => (
						t.type === this.firstInputTrack!.type && t.number === this.firstInputTrack!.number
					));

					let nextPacket: EncodedPacket | null = null;
					if (nextTrack) {
						const metadataOptions = { ...options, metadataOnly: true };

						packetResult.reset();
						const firstPromise = nextTrack._backing.getFirstPacket(packetResult, metadataOptions);
						if (packetResult.pending) await firstPromise;

						nextPacket = packetResult.value.packet;
						if (nextPacket && keyframesOnly && nextPacket.type !== 'key') {
							packetResult.reset();
							const keyPromise = nextTrack._backing.getNextKeyPacket(
								packetResult,
								nextPacket,
								metadataOptions,
							);
							if (packetResult.pending) await keyPromise;

							nextPacket = packetResult.value.packet;
						}
					}

					if (nextPacket) {
						mediaOffsetResult.reset();
						const nextMediaOffsetPromise = this.segmentedInput.getMediaOffset(
							mediaOffsetResult,
							nextSegment,
							nextInput,
						);
						if (mediaOffsetResult.pending) await nextMediaOffsetPromise;

						if (nextPacket.timestamp + mediaOffsetResult.value <= timestamp) {
							currentSegment = nextSegment;
							continue;
						}
					}
				}
			}

			return this.createAdjustedPacket(res, packet, currentSegment, track, provisional);
		}

		const result = new PacketRetrievalResult(null);
		result.provisional = provisional;

		return res.set(result);
	}
}

/** Retrieves the tracks of an input, synchronously if the input's tracks have already been determined. */
const getTracksMaybeSync = (input: Input): MaybePromise<InputTrack[]> => {
	if (input._trackBackingsCache) {
		return input._trackBackingsCache.map(x => input._wrapBackingAsTrack(x));
	}

	return input.getTracks();
};

class SegmentedInputInputVideoTrackBacking
	extends SegmentedInputInputTrackBacking
	implements InputVideoTrackBacking {
	declare firstInputTrack: InputVideoTrack | null;

	override getType() {
		return 'video' as const;
	}

	override getCodec() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodec());
	}

	getCodedWidth() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodedWidth());
	}

	getCodedHeight() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodedHeight());
	}

	getSquarePixelWidth() {
		return this.delegate(() => this.firstInputTrack!._backing.getSquarePixelWidth());
	}

	getSquarePixelHeight() {
		return this.delegate(() => this.firstInputTrack!._backing.getSquarePixelHeight());
	}

	getTransformationMatrix() {
		return this.delegate(() => this.firstInputTrack!._backing.getTransformationMatrix());
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.delegate(() => this.firstInputTrack!._backing.getColorSpace());
	}

	async canBeTransparent(): Promise<boolean> {
		return this.delegate(() => this.firstInputTrack!._backing.canBeTransparent());
	}

	getFieldOrder() {
		return this.delegate(() => this.firstInputTrack!._backing.getFieldOrder?.() ?? null);
	}

	override async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.delegate(() => this.firstInputTrack!._backing.getDecoderConfig());
	}
}

class SegmentedInputInputAudioTrackBacking
	extends SegmentedInputInputTrackBacking
	implements InputAudioTrackBacking {
	declare firstInputTrack: InputAudioTrack;

	override getType() {
		return 'audio' as const;
	}

	override getCodec() {
		return this.delegate(() => this.firstInputTrack._backing.getCodec());
	}

	getNumberOfChannels() {
		return this.delegate(() => this.firstInputTrack._backing.getNumberOfChannels());
	}

	getSampleRate() {
		return this.delegate(() => this.firstInputTrack._backing.getSampleRate());
	}

	override async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		return this.delegate(() => this.firstInputTrack._backing.getDecoderConfig());
	}
}
