import { expect, test } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { assert } from '../../src/misc.js';
import { Reader, readBytes } from '../../src/reader.js';
import {
	ALL_FORMATS,
	EncodedPacket,
	FilePathSource,
	Input,
	Logging,
	LogLevel,
	ReadCanceledError,
	UrlSource,
} from '../../src/index.js';
import { PacketCursor } from '../../src/cursors.js';
import { PacketReader } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const videoFilePath = path.join(__dirname, '..', 'public/video.mp4');

test('UrlSource works against a server without range request support', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			source: new UrlSource(server.url),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const packetReader = new PacketReader(track);
		const cursor = new PacketCursor(track);

		const timestamps: number[] = [];
		for await (const packet of cursor) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		// The default cache size exceeds the file size, so random access back to the start of the file still works
		const firstPacket = await packetReader.getFirst();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource throws when reading from an evicted region in sequential mode', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// Much smaller than the file, so the start of the file will get evicted during full iteration
			source: new UrlSource(server.url, { maxCacheSize: 2 ** 20 /* 1 MiB */ }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const packetReader = new PacketReader(track);
		const cursor = new PacketCursor(track);

		const timestamps: number[] = [];
		for await (const packet of cursor) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		await expect(async () => packetReader.getFirst()).rejects.toThrow(/already-evicted part of the cache/);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource resumes with correct data when the connection dies in sequential mode', async () => {
	// The server kills the connection partway through the first two responses. Since it doesn't support range
	// requests, each resume response starts back at byte 0 and the already-delivered prefix must be skipped over
	// exactly; any off-by-one would corrupt the packet data.
	const server = await startRangelessServer({ responseByteLimits: [700_000, 1_500_000] });
	const logs = captureLogs();

	try {
		using referenceInput = new Input({
			source: new FilePathSource(videoFilePath),
			formats: ALL_FORMATS,
		});

		const referenceTrack = await referenceInput.getPrimaryVideoTrack();
		if (!referenceTrack) throw new Error('No video track found');

		const referencePackets: EncodedPacket[] = [];
		for await (const packet of new PacketCursor(referenceTrack)) {
			referencePackets.push(packet);
		}

		using input = new Input({
			source: new UrlSource(server.url, { getRetryDelay: () => 0 }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		let packetIndex = 0;
		for await (const packet of new PacketCursor(track)) {
			const referencePacket = referencePackets[packetIndex]!;

			expect(packet.timestamp).toBe(referencePacket.timestamp);
			expect(Buffer.from(packet.data).equals(Buffer.from(referencePacket.data))).toBe(true);

			packetIndex++;
		}

		expect(packetIndex).toBe(referencePackets.length);

		// Initial request plus one resume per killed response
		expect(server.requestCount()).toBe(3);
		expect(logs.errors.filter(x => x.includes('Attempting to resume'))).toHaveLength(2);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource with maxCacheSize: Infinity allows random access against a rangeless server', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// This is the escape hatch recommended by the eviction error message: with an infinite cache, nothing
			// is ever evicted and random access keeps working
			source: new UrlSource(server.url, { maxCacheSize: Infinity }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const packetReader = new PacketReader(track);
		const cursor = new PacketCursor(track);

		const timestamps: number[] = [];
		for await (const packet of cursor) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		const firstPacket = await packetReader.getFirst();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource in sequential mode downloads lazily and aborts the response on dispose', async () => {
	// The resource is padded to a size far beyond what kernel socket buffers can swallow. This matters: the server
	// can only observe the client's laziness through backpressure, and on some systems (like Linux with its TCP
	// buffer autotuning), the kernel happily buffers multiple megabytes of sent data that the client never read.
	const paddingSize = 2 ** 26; // 64 MiB
	const totalSize = fs.statSync(videoFilePath).size + paddingSize;

	const server = await startRangelessServer({ trailingPaddingSize: paddingSize });
	const logs = captureLogs();

	const input = new Input({
		source: new UrlSource(server.url),
		formats: ALL_FORMATS,
	});

	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		// If the client were downloading eagerly, the entire resource would easily arrive during this window.
		// Instead, the server is expected to stall, since data is only pulled down when reads demand it.
		await new Promise(resolve => setTimeout(resolve, 3000));

		expect(server.bytesSent()).toBeLessThan(totalSize / 2);

		// The response is merely suspended, not dead: reading still works
		const packetReader = new PacketReader(track);
		const firstPacket = await packetReader.getFirst();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		input.dispose();

		// Give the abort a moment to propagate to the server
		await new Promise(resolve => setTimeout(resolve, 250));

		// Disposal terminated the response early, long before the entire resource was sent
		expect(server.abortedResponses()).toBe(1);
		expect(server.bytesSent()).toBeLessThan(totalSize / 2);
	} finally {
		input.dispose();
		logs.stop();
		server.close();
	}
}, 10_000);

test('UrlSource reads the full decoded body of a compressed response', async () => {
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(200, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Length': compressed.byteLength,
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource reads the full decoded body of a compressed 206 response', async () => {
	// A 206 carrying Content-Encoding states its Content-Range in compressed bytes, so trusting that
	// total truncates the decoded document.
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(206, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Range': `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
			'Content-Length': compressed.byteLength,
			'Accept-Ranges': 'bytes',
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

const rangedResourceSize = 2 ** 25; // 32 MiB
const sequentialReadSize = 2 ** 16;
const testReadAhead = 2 ** 22; // 4 MiB
// What socket and stream buffers may hold beyond what the client read, which the server counts as sent
const sendBufferSlack = 2 ** 23;
const responseHoldTime = 4000;

const readSequentially = async (reader: Reader, start: number, end: number) => {
	for (let pos = start; pos < end; pos += sequentialReadSize) {
		let slice = reader.requestSlice(pos, sequentialReadSize);
		if (slice instanceof Promise) slice = await slice;
		assert(slice);
		expect(readBytes(slice, 1)[0]).toBe(rangedResourceByte(pos));
	}
};

test('UrlSource keeps a sequential reader on one response, across pauses shorter than its hold', async () => {
	const server = await startRangedServer();

	try {
		const source = new UrlSource(server.url, { readAhead: testReadAhead });
		using ref = source.ref();
		const reader = new Reader(ref.source);

		await readSequentially(reader, 0, rangedResourceSize / 2);
		// The response reaches its target meanwhile and waits there, read ahead of the reader by readAhead
		await new Promise(resolve => setTimeout(resolve, 1000));
		expect(server.bytesSent()).toBeLessThan(rangedResourceSize / 2 + testReadAhead + sendBufferSlack);

		await readSequentially(reader, rangedResourceSize / 2, rangedResourceSize);

		expect(server.requestCount()).toBe(1);
		expect(server.abortedResponses()).toBe(0);
	} finally {
		server.close();
	}
});

test('UrlSource closes a held response after its hold time and reads on with a new request', async () => {
	const server = await startRangedServer();

	try {
		const source = new UrlSource(server.url, { readAhead: testReadAhead });
		using ref = source.ref();
		const reader = new Reader(ref.source);

		await readSequentially(reader, 0, testReadAhead);
		await new Promise(resolve => setTimeout(resolve, responseHoldTime + 1000));
		expect(server.abortedResponses()).toBe(1);

		await readSequentially(reader, testReadAhead, 4 * testReadAhead);
		expect(server.requestCount()).toBe(2);
	} finally {
		server.close();
	}
}, 15_000);

test('UrlSource.cancelReads rejects waiting reads and stops prefetching, while reading on continues', async () => {
	const server = await startRangedServer();

	try {
		const source = new UrlSource(server.url, { readAhead: testReadAhead });
		using ref = source.ref();
		const reader = new Reader(ref.source);

		await readSequentially(reader, 0, testReadAhead);
		const requestsBeforeFarRead = server.requestCount();

		const farRead = reader.requestSlice(rangedResourceSize / 2, sequentialReadSize);
		assert(farRead instanceof Promise);
		source.cancelReads();
		await expect(farRead).rejects.toBeInstanceOf(ReadCanceledError);

		// Reading on where reading stopped continues on the response that was open, without a new request
		await readSequentially(reader, testReadAhead, 2 * testReadAhead);
		expect(server.requestCount()).toBe(requestsBeforeFarRead + 1);

		// A read elsewhere afterwards works as usual
		await readSequentially(reader, rangedResourceSize / 2, rangedResourceSize / 2 + testReadAhead);
	} finally {
		server.close();
	}
});

test('UrlSource lets a held response give way to a read that needs its request', async () => {
	const server = await startRangedServer();

	try {
		const source = new UrlSource(server.url, { readAhead: testReadAhead, parallelism: 1 });
		using ref = source.ref();
		const reader = new Reader(ref.source);

		await readSequentially(reader, 0, testReadAhead);
		// Let the only response reach its target and wait there
		await new Promise(resolve => setTimeout(resolve, 500));

		const farReadStart = performance.now();
		await readSequentially(reader, rangedResourceSize / 2, rangedResourceSize / 2 + sequentialReadSize);

		expect(performance.now() - farReadStart).toBeLessThan(responseHoldTime / 2);
		expect(server.requestCount()).toBe(2);
	} finally {
		server.close();
	}
});

test('UrlSource keeps pinned data cached while evicting the rest', async () => {
	const server = await startRangedServer();

	try {
		const source = new UrlSource(server.url, { readAhead: 2 ** 20, maxCacheSize: 2 ** 21 });
		using ref = source.ref();
		const reader = new Reader(ref.source);

		await readSequentially(reader, 0, 2 ** 18);
		source.pinCache();
		await readSequentially(reader, rangedResourceSize / 2, rangedResourceSize / 2 + 2 ** 18);
		// Far more than the cache holds
		await readSequentially(reader, rangedResourceSize / 4, rangedResourceSize / 4 + 2 ** 23);

		const pinnedSlice = reader.requestSlice(0, 2 ** 18);
		expect(pinnedSlice).not.toBeInstanceOf(Promise);

		const evictedSlice = reader.requestSlice(rangedResourceSize / 2, 2 ** 18);
		expect(evictedSlice).toBeInstanceOf(Promise);
		await evictedSlice;
	} finally {
		server.close();
	}
});

test('UrlSource keeps the data being read cached beside pinned data larger than its max cache size', async () => {
	const server = await startRangedServer();

	try {
		const source = new UrlSource(server.url, { readAhead: 2 ** 18 });
		using ref = source.ref();
		const reader = new Reader(ref.source);

		await readSequentially(reader, 0, 2 ** 22);
		source.pinCache();
		// A quarter of what's pinned
		source.setMaxCacheSize(2 ** 20);
		await readSequentially(reader, rangedResourceSize / 2, rangedResourceSize / 2 + 2 ** 18);

		expect(reader.requestSlice(0, 2 ** 22)).not.toBeInstanceOf(Promise);
		expect(reader.requestSlice(rangedResourceSize / 2, 2 ** 18)).not.toBeInstanceOf(Promise);
	} finally {
		server.close();
	}
});

test('UrlSource validates its read-ahead and cache size', () => {
	expect(() => new UrlSource('https://example.com/a.mp4', { readAhead: 0 })).toThrow(TypeError);

	const source = new UrlSource('https://example.com/a.mp4');
	expect(() => source.setReadAhead(-1)).toThrow(TypeError);
	expect(() => source.setReadAhead(Number.NaN)).toThrow(TypeError);
	expect(() => source.setMaxCacheSize(-1)).toThrow(TypeError);
	source.setReadAhead(2 ** 20);
	source.setMaxCacheSize(0);
});

const rangedResourceByte = (pos: number) => (pos * 7 + 3) & 0xff;

/** Serves a synthetic resource with range support, writing each response with backpressure. */
const startRangedServer = async () => {
	let requestCount = 0;
	let bytesSent = 0;
	let abortedResponses = 0;

	const server = http.createServer((req, res) => {
		requestCount++;
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
		const start = range ? Number(range[1]) : 0;
		const end = range && range[2] ? Number(range[2]) + 1 : rangedResourceSize;

		res.on('error', () => {}); // The client may abort the connection at any time
		res.on('close', () => {
			if (!res.writableFinished) {
				abortedResponses++;
			}
		});
		res.writeHead(range ? 206 : 200, {
			'Content-Type': 'application/octet-stream',
			'Content-Length': end - start,
			...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${rangedResourceSize}` } : {}),
		});

		let pos = start;
		const writeMore = () => {
			while (pos < end) {
				const chunk = Buffer.alloc(Math.min(2 ** 14, end - pos));
				for (let i = 0; i < chunk.length; i++) {
					chunk[i] = rangedResourceByte(pos + i);
				}

				pos += chunk.length;
				bytesSent += chunk.length;

				if (!res.write(chunk)) {
					res.once('drain', writeMore);
					return;
				}
			}

			res.end();
		};
		writeMore();
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unexpected server address');

	return {
		url: `http://localhost:${address.port}/resource.bin`,
		requestCount: () => requestCount,
		bytesSent: () => bytesSent,
		abortedResponses: () => abortedResponses,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

const startRangelessServer = async (
	options: { responseByteLimits?: number[]; trailingPaddingSize?: number } = {},
) => {
	const fileSize = fs.statSync(videoFilePath).size;
	const paddingSize = options.trailingPaddingSize ?? 0;
	let requestCount = 0;
	let bytesSent = 0;
	let abortedResponses = 0;

	const server = http.createServer((req, res) => {
		const byteLimit = options.responseByteLimits?.[requestCount] ?? Infinity;
		requestCount++;

		res.on('error', () => {}); // The client may abort the connection at any time
		res.on('close', () => {
			if (!res.writableFinished) {
				abortedResponses++;
			}
		});
		res.writeHead(200, {
			'Content-Type': 'video/mp4',
			'Content-Length': fileSize + paddingSize,
		});

		// Stream the file with backpressure and a small chunk size, so that the amount of sent bytes closely
		// tracks how much the client actually consumes
		const stream = fs.createReadStream(videoFilePath, { highWaterMark: 2 ** 14 });
		let bytesSentThisResponse = 0;

		stream.on('data', (chunk) => {
			const canContinue = res.write(chunk);
			bytesSent += chunk.length;
			bytesSentThisResponse += chunk.length;

			if (bytesSentThisResponse >= byteLimit) {
				stream.destroy();
				res.destroy(); // Kill the connection mid-response

				return;
			}

			if (!canContinue) {
				stream.pause();
				res.once('drain', () => stream.resume());
			}
		});
		stream.on('end', () => {
			if (paddingSize === 0) {
				res.end();
				return;
			}

			// Append a giant 'free' box: valid ISOBMFF, but never read by the demuxer
			const header = Buffer.alloc(8);
			header.writeUInt32BE(paddingSize, 0);
			header.write('free', 4, 'latin1');

			const zeroes = Buffer.alloc(2 ** 14);
			let paddingSent = 0;

			const writeMore = () => {
				while (paddingSent < paddingSize) {
					const chunk = paddingSent === 0
						? header
						: zeroes.subarray(0, Math.min(paddingSize - paddingSent, zeroes.length));

					paddingSent += chunk.length;
					bytesSent += chunk.length;

					if (!res.write(chunk)) {
						res.once('drain', writeMore);
						return;
					}
				}

				res.end();
			};
			writeMore();
		});
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unexpected server address');

	return {
		url: `http://localhost:${address.port}/video.mp4`,
		requestCount: () => requestCount,
		bytesSent: () => bytesSent,
		abortedResponses: () => abortedResponses,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

/** Collects logged warnings and errors, keeping the console clean while doing so. */
const captureLogs = () => {
	const warnings: string[] = [];
	const errors: string[] = [];
	const unsubscribeWarn = Logging.on('warn', args => warnings.push(args.map(String).join(' ')));
	const unsubscribeError = Logging.on('error', args => errors.push(args.map(String).join(' ')));

	const previousLogLevel = Logging.level;
	Logging.level = LogLevel.Silent;

	return {
		warnings,
		errors,
		stop: () => {
			unsubscribeWarn();
			unsubscribeError();
			Logging.level = previousLogLevel;
		},
	};
};
