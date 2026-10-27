/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { binarySearchLessOrEqual } from '../misc';
import { PictureOrder, PictureOrderReader } from './avi-picture-order';

/** What the presentation times need of a stream's packet. */
export type AviTimedPacket = {
	/** The start of the packet's slot, counted in decode order as AVI times its chunks. */
	timestamp: number;
	isKey: boolean;
	entry: { size: number };
};

// The bytes of a packet read first for its picture's order; a picture whose headers run past them is read again from
// four times as many
const FIRST_PACKET_PREFIX_BYTE_COUNT = 256;

/**
 * Gives a video stream's packets their presentation timestamps.
 *
 * AVI times a stream's chunks one slot each in file order, which is decode order, so a stream that reorders its
 * pictures, as H.264 and HEVC with B-frames do, keeps no presentation times. They are recovered here from each
 * picture's order count, read from its slice header, independent of any decoder's output order.
 *
 * The packets from one key packet to the next form a group that presents in the slots it takes in decode order: its
 * pictures, sorted by order count, take its slots in turn. Every timestamp is then delayed by the stream's reorder
 * depth, which its sequence parameter set declares, so that no picture presents before it is decoded, as FFmpeg's
 * timestamps for such a stream are. A group is read only when one of its timestamps is asked for, so a seek reads the
 * headers of one or two groups.
 */
export class AviPresentationTimes {
	/** Each packet's presentation timestamp, NaN until its group is read. */
	private timestamps: Float64Array;
	/** The index of each group's first packet: 0, then each key packet's. */
	private groupStarts: number[];
	private groupPromises = new Map<number, Promise<void>>();
	/** Reads one group at a time, since the reader carries each group's order count state. */
	private readQueue: Promise<void> = Promise.resolve();
	private initializationPromise: Promise<void> | null = null;
	/** Whether the stream reorders its pictures, so that its timestamps need reading. */
	private reorders = false;
	private delay = 0;

	constructor(
		private packets: AviTimedPacket[],
		keyPacketIndices: number[],
		private reader: PictureOrderReader | null,
		/** The duration of one slot, in which the reorder depth counts. */
		private slotDuration: number,
		private readPacketPrefix: (packetIndex: number, byteCount: number) => Promise<Uint8Array | null>,
	) {
		this.timestamps = new Float64Array(packets.length).fill(NaN);
		this.groupStarts = keyPacketIndices[0] === 0 ? [...keyPacketIndices] : [0, ...keyPacketIndices];
	}

	/** Returns the presentation timestamp of the packet at an index of the stream's packets. */
	async getTimestamp(packetIndex: number) {
		await this.initialize();
		if (!this.reorders) {
			return this.packets[packetIndex]!.timestamp;
		}

		await this.readGroup(binarySearchLessOrEqual(this.groupStarts, packetIndex, x => x));
		return this.timestamps[packetIndex]!;
	}

	/** Returns the index of the last packet in presentation order that starts at or before a timestamp, or -1. */
	async findPacket(timestamp: number) {
		await this.initialize();
		if (!this.reorders) {
			return binarySearchLessOrEqual(this.packets, timestamp, x => x.timestamp);
		}

		// Groups present one after another, each from its first slot on
		const group = this.findGroup(timestamp);
		if (group === -1) {
			return -1;
		}

		await this.readGroup(group);
		let found = -1;
		const end = this.groupStarts[group + 1] ?? this.packets.length;
		for (let i = this.groupStarts[group]!; i < end; i++) {
			const packetTimestamp = this.timestamps[i]!;
			if (packetTimestamp <= timestamp && (found === -1 || packetTimestamp > this.timestamps[found]!)) {
				found = i;
			}
		}

		return found;
	}

	/** Returns the index of the last key packet in presentation order that starts at or before a timestamp, or -1. */
	async findKeyPacket(timestamp: number, keyPacketIndices: number[]) {
		await this.initialize();
		if (!this.reorders) {
			const keyIndex = binarySearchLessOrEqual(keyPacketIndices, timestamp, x => this.packets[x]!.timestamp);
			return keyIndex === -1 ? -1 : keyPacketIndices[keyIndex]!;
		}

		// A key packet presents after every picture of the groups before it, but its group's leading pictures present
		// before it, so the key packet of the group a timestamp falls in may start after that timestamp
		for (let group = this.findGroup(timestamp); group >= 0; group--) {
			const start = this.groupStarts[group]!;
			if (!this.packets[start]!.isKey) {
				continue;
			}

			await this.readGroup(group);
			if (this.timestamps[start]! <= timestamp) {
				return start;
			}
		}

		return -1;
	}

	private initialize() {
		return this.initializationPromise ??= this.readReorderDepth();
	}

	/**
	 * Reads the stream's first key packet for the reorder depth its sequence declares. A stream that outputs in decode
	 * order keeps its slot timestamps; one that declares no depth takes the deepest reordering of its first group.
	 */
	private async readReorderDepth() {
		const reader = this.reader;
		const firstKeyIndex = this.groupStarts.find(index => this.packets[index]!.isKey);
		if (!reader || firstKeyIndex === undefined) {
			return;
		}

		reader.reset();
		const firstPicture = await this.readPictureOrder(firstKeyIndex);
		if (!firstPicture || reader.outputsInDecodeOrder()) {
			return;
		}

		this.reorders = true;
		let reorderDepth = reader.getDeclaredReorderDepth();
		if (reorderDepth === null) {
			const start = firstKeyIndex;
			const order = await this.readGroupOrder(binarySearchLessOrEqual(this.groupStarts, start, x => x));
			reorderDepth = Math.max(0, ...order.map((packetIndex, rank) => packetIndex - start - rank));
		}
		this.delay = reorderDepth * this.slotDuration;
	}

	/** Returns the last group whose first presentation timestamp is at or before a timestamp, or -1. */
	private findGroup(timestamp: number) {
		return binarySearchLessOrEqual(this.groupStarts, timestamp, x => this.packets[x]!.timestamp + this.delay);
	}

	private readGroup(group: number) {
		let promise = this.groupPromises.get(group);
		if (!promise) {
			promise = this.readGroupOrder(group).then((order) => {
				// The group's pictures take its slots in presentation order
				const start = this.groupStarts[group]!;
				for (let rank = 0; rank < order.length; rank++) {
					this.timestamps[order[rank]!] = this.packets[start + rank]!.timestamp + this.delay;
				}
			});
			this.groupPromises.set(group, promise);
			promise.catch(() => this.groupPromises.delete(group));
		}

		return promise;
	}

	/**
	 * Returns a group's packet indices in presentation order. A group with a picture that cannot be placed keeps
	 * decode order, which its slots give it.
	 */
	private readGroupOrder(group: number) {
		const read = this.readQueue.then(async () => {
			const start = this.groupStarts[group]!;
			const end = this.groupStarts[group + 1] ?? this.packets.length;
			const order: number[] = [];
			const pictureOrders: (PictureOrder | null)[] = [];

			this.reader!.reset();
			for (let i = start; i < end; i++) {
				order.push(i);
				pictureOrders.push(await this.readPictureOrder(i));
			}

			if (pictureOrders.every(pictureOrder => pictureOrder !== null)) {
				order.sort((a, b) => {
					const orderA = pictureOrders[a - start]!;
					const orderB = pictureOrders[b - start]!;
					return orderA.epoch - orderB.epoch || orderA.orderCount - orderB.orderCount || a - b;
				});
			}

			return order;
		});
		this.readQueue = read.then(() => {}, () => {});

		return read;
	}

	/** Reads the order of a packet's picture from as few of its bytes as hold its headers. */
	private async readPictureOrder(packetIndex: number) {
		const size = this.packets[packetIndex]!.entry.size;
		let byteCount = Math.min(size, FIRST_PACKET_PREFIX_BYTE_COUNT);
		while (true) {
			const data = await this.readPacketPrefix(packetIndex, byteCount);
			if (!data) {
				return null;
			}

			const result = this.reader!.readPicture(data, byteCount === size);
			if (result !== 'truncated') {
				return result;
			}
			byteCount = Math.min(size, byteCount * 4);
		}
	}
}
