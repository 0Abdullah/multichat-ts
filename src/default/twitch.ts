import { WebSocket } from 'partysocket';

import {
	type BodyComponent,
	type ClearMessages,
	type DeleteMessage,
	type Message,
	type Event,
	type EmoteURLsByName,
	type BadgeURLsBySetIDOrSetIDAndVersion,
} from './index.js';
import { buildMessageBody, runSafely } from './safety.js';

const ANONYMOUS_IRC_PASS = 'SCHMOOPIIE';
const ANONYMOUS_IRC_LOGIN = 'justinfan1234';
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;

type EventCallbackFunctions = {
	message: (message: Message) => unknown;
	clear_messages: (data: ClearMessages) => unknown;
	delete_message: (data: DeleteMessage) => unknown;
	event: (event: Event) => unknown;
	raw_message: (message: IRC_Message) => unknown;
	connected: () => unknown;
	auth_error: () => unknown;
};

type EventNames = keyof EventCallbackFunctions;

type SocketOptions = NonNullable<ConstructorParameters<typeof WebSocket>[2]>;

export class TwitchIRC {
	public channel_name?: string;
	public auth?: { username: string; token: string } | undefined;
	public bot_name?: string;
	public bot_token?: string;

	private assets: {
		external_emotes: EmoteURLsByName;
		badges: BadgeURLsBySetIDOrSetIDAndVersion;
	} = {
		external_emotes: {},
		badges: {},
	};

	public latency = 0;
	private ping: {
		interval?: ReturnType<typeof setInterval>;
		lastSentTimestamp?: number | undefined;
		timeout?: ReturnType<typeof setTimeout>;
	} = {};

	private public_listeners: Partial<EventCallbackFunctions> = {};

	public socket?: WebSocket | undefined;
	public wsCustom?: SocketOptions['WebSocket'];

	constructor(
		options: {
			ws?: SocketOptions['WebSocket'];
			auth?: { username: string; token: string };
		} = {},
	) {
		this.wsCustom = options.ws;
		this.auth = options.auth;
	}

	public setBadges(badges: BadgeURLsBySetIDOrSetIDAndVersion) {
		this.assets.badges = { ...this.assets.badges, ...badges };
	}

	public setExternalEmotes(externalEmotes: EmoteURLsByName) {
		this.assets.external_emotes = {
			...this.assets.external_emotes,
			...externalEmotes,
		};
	}

	public getStoredBadges() {
		return this.assets.badges;
	}

	public getStoredExternalEmotes() {
		return this.assets.external_emotes;
	}

	public authenticate(username: string, token: string): void {
		this.auth = { username, token };
		this.bot_name = username;
		this.bot_token = token;
	}

	private clearPing(): void {
		clearInterval(this.ping.interval);
		clearTimeout(this.ping.timeout);
		this.ping = {};
	}

	public connect(channel?: { channelName?: string }): void {
		if (channel?.channelName) {
			this.channel_name = channel.channelName;
		}

		if (!this.channel_name) {
			throw new Error('Twitch channel_name not specified');
		}

		this.disconnect();

		const socket = new WebSocket('wss://irc-ws.chat.twitch.tv', null, {
			WebSocket: this.wsCustom,
		});

		this.socket = socket;

		socket.onopen = () => {
			if (this.socket !== socket) return;
			runSafely('twitch.open', () => this.onOpen());
		};

		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.clearPing();
		};

		socket.onerror = () => {
			if (this.socket !== socket) return;

			console.error('Twitch WebSocket error', {
				channel: this.channel_name,
			});
		};

		socket.onmessage = (event) => {
			if (this.socket !== socket) return;
			runSafely('twitch.frame', () => this.onMessage(event));
		};
	}

	public send(message: string, replyParentMessageId?: string): void {
		if (!this.auth) {
			console.error('No Twitch auth information');
			return;
		}

		const text = message.replace(/[\r\n]/g, ' ');

		if (replyParentMessageId !== undefined && !/^[A-Za-z0-9-]+$/.test(replyParentMessageId)) {
			throw new Error('Invalid reply parent message ID');
		}

		const prefix = replyParentMessageId ? `@reply-parent-msg-id=${replyParentMessageId} ` : '';

		this.sendIRC(`${prefix}PRIVMSG #${this.channel_name} :${text}`);
	}

	public disconnect(): void {
		this.clearPing();

		const socket = this.socket;
		this.socket = undefined;

		if (!socket) return;

		socket.onopen = null;
		socket.onclose = null;
		socket.onmessage = null;
		socket.onerror = null;

		runSafely('twitch.disconnect', () => socket.close());
	}

	private restartConnection(): void {
		this.clearPing();

		runSafely('twitch.reconnect', () => this.socket?.reconnect());
	}

	public on<EventName extends EventNames>(
		event_name: EventName,
		callback_fn: EventCallbackFunctions[EventName],
	) {
		this.public_listeners[event_name] = callback_fn;
	}

	public isConnected(): this is { socket: { readyState: typeof WebSocket.OPEN } & WebSocket } {
		return !!this.socket && this.socket.readyState === WebSocket.OPEN;
	}

	// private onClose() {
	// 	clearInterval(this.ping.interval);
	// 	clearTimeout(this.ping.timeout);
	// }

	private onOpen(): void {
		this.clearPing();

		const token = this.auth?.token.replace(/^oauth:/, '');

		const commands = [
			'CAP REQ :twitch.tv/commands twitch.tv/tags',
			this.auth ? `PASS oauth:${token}` : `PASS ${ANONYMOUS_IRC_PASS}`,
			`NICK ${this.auth?.username ?? ANONYMOUS_IRC_LOGIN}`,
			`JOIN #${this.channel_name}`,
		];

		for (const command of commands) {
			if (!this.sendIRC(command)) return;
		}

		this.sendPing();

		if (!this.isConnected()) return;

		this.ping.interval = setInterval(() => {
			runSafely('twitch.ping', () => this.sendPing());
		}, PING_INTERVAL_MS);
	}

	private sendPing(): void {
		if (this.ping.lastSentTimestamp !== undefined) return;
		if (!this.sendIRC('PING :multichat')) return;

		this.ping.lastSentTimestamp = Date.now();

		this.ping.timeout = setTimeout(() => {
			console.error('Twitch PING timeout');
			this.restartConnection();
		}, PING_TIMEOUT_MS);
	}

	private sendIRC(message: string): boolean {
		if (!this.isConnected()) return false;

		try {
			this.socket.send(message);
			return true;
		} catch (error) {
			console.error('Twitch send failed', error);
			this.restartConnection();
			return false;
		}
	}

	private onMessage(event: MessageEvent): void {
		if (typeof event.data !== 'string') {
			console.warn('Ignoring non-text Twitch WebSocket frame', JSON.stringify(event));
			return;
		}

		const socket = this.socket;

		for (const line of event.data.split('\r\n')) {
			if (!line) continue;

			if (this.socket !== socket || !this.isConnected()) break;

			runSafely('twitch.irc_line', () => {
				const message = parseIRCLine(line);

				if (!message) {
					console.warn('Ignoring malformed Twitch IRC line', JSON.stringify(message));
					return;
				}

				this.handleIRCMessage(message);
			});
		}
	}

	private handleIRCMessage(message: IRC_Message): void {
		runSafely('twitch.raw_message', () => this.public_listeners.raw_message?.(message));

		switch (message.command) {
			case 'PONG': {
				const sentAt = this.ping.lastSentTimestamp;

				if (sentAt === undefined) break;

				clearTimeout(this.ping.timeout);
				this.latency = Date.now() - sentAt;
				this.ping.lastSentTimestamp = undefined;
				break;
			}
			case 'PING': {
				const token = message.params.at(-1);

				this.sendIRC(token === undefined ? 'PONG' : `PONG :${token}`);
				break;
			}
			case '001': {
				console.log(`Connected to Twitch IRC (${this.channel_name})`);

				runSafely('twitch.connected', () => this.public_listeners.connected?.());
				break;
			}
			case 'RECONNECT': {
				this.restartConnection();
				break;
			}
			case 'NOTICE': {
				const text = message.params.at(-1);

				if (text === 'Login authentication failed' || text === 'Improperly formatted auth') {
					this.disconnect();

					runSafely('twitch.auth_error', () => this.public_listeners.auth_error?.());
				}

				break;
			}
			case 'CLEARCHAT': {
				const { channel, tags } = message;
				if (!tags) return;
				const data = {
					channel: {
						name: channel,
						room_id: tags['room-id'] ?? 'unknown',
					},
					timestamp_sent: Number(tags['tmi-sent-ts']),
					timeout_duration_seconds: tags['ban-duration'] ? Number(tags['ban-duration']) : undefined,
				};
				runSafely('twitch.clear_messages', () => {
					this.public_listeners.clear_messages?.(data);
				});
				break;
			}
			case 'PRIVMSG': {
				const { channel, params, tags, source } = message;
				if (!tags || !tags['user-id'] || !tags['id'] || !tags['room-id']) return;

				const rawText = params[0];
				if (!rawText) return;

				const actionPrefix = '\u0001ACTION ';
				const isAction = rawText.startsWith(actionPrefix) && rawText.endsWith('\u0001');

				const text = isAction ? rawText.slice(actionPrefix.length, -1) : rawText;

				const offset = isAction ? actionPrefix.length : 0;

				const boundaries = [0];
				let utf16Offset = 0;

				for (const character of rawText) {
					utf16Offset += character.length;
					boundaries.push(utf16Offset);
				}

				const emotes: BodyComponent[] = [];

				for (const encoded of tags['emotes']?.split('/') ?? []) {
					const colon = encoded.indexOf(':');
					if (colon === -1) continue;

					const id = encoded.slice(0, colon);
					if (!id) continue;

					for (const range of encoded.slice(colon + 1).split(',')) {
						const match = /^(\d+)-(\d+)$/.exec(range);
						if (!match) continue;

						const first = Number(match[1]);
						const last = Number(match[2]);

						if (last < first) continue;

						const rawStart = boundaries[first];
						const rawEnd = boundaries[last + 1];

						if (rawStart === undefined || rawEnd === undefined) continue;

						emotes.push({
							type: 'emote',
							start_inclusive: rawStart - offset,
							end_exclusive: rawEnd - offset,
							url:
								'https://static-cdn.jtvnw.net/emoticons/v2/' +
								`${encodeURIComponent(id)}/default/dark/1.0`,
						});
					}
				}

				const body = buildMessageBody(text, emotes);

				const badge_info: {
					[set_id: string]: string;
				} = {};
				tags['badge-info']?.split(',').forEach((badge) => {
					const [set_id, info] = badge.split('/');
					if (!set_id || !info) return;

					badge_info[set_id] = info;
				});

				const timestamp = Number(tags['tmi-sent-ts']);

				const data = {
					body: body,
					channel: {
						room_id: tags['room-id'],
						name: channel,
					},
					id: tags['id'],
					raw_text: text,
					timestamp_sent: Number.isFinite(timestamp) ? timestamp : Date.now(),
					user: {
						badges:
							tags['badges']?.split(',').flatMap((badge) => {
								const [set_id, version] = badge.split('/');
								if (!set_id || !version) return [];

								const storedBadge = this.assets.badges[set_id];
								if (!storedBadge) return [];

								const url = typeof storedBadge === 'object' ? storedBadge[version] : storedBadge;
								if (typeof url !== 'string' || !url) return [];

								return {
									info: badge_info[set_id],
									set_id,
									url,
								};
							}) ?? [],
						color: tags['color'] ?? '#FFFFFF',
						id: tags['user-id'],
						username: source?.user ?? 'Unknown',
						display_name: tags['display-name'] ?? 'Unknown',
						roles: {
							admin: tags['user-type'] === 'admin',
							global_moderator: tags['user-type'] === 'global_mod',
							staff: tags['user-type'] === 'staff',
							turbo: tags['turbo'] === '1',
							vip: tags['vip'] === '1',
							moderator: tags['mod'] === '1',
						},
					},
				};

				runSafely('twitch.message', () => {
					this.public_listeners.message?.(data);
				});
				break;
			}
		}
	}
}

export function parseIRCLine(line: string): IRC_Message | undefined {
	let rest = line.replace(/[\r\n]+$/, '').trimStart();

	if (!rest) return undefined;

	const takeToken = (): string => {
		const space = rest.indexOf(' ');

		if (space === -1) {
			const token = rest;
			rest = '';
			return token;
		}

		const token = rest.slice(0, space);
		rest = rest.slice(space + 1).trimStart();
		return token;
	};

	let tags: IRC_Message['tags'];
	let source: RawSource | undefined;

	if (rest.startsWith('@')) {
		tags = parseTags(takeToken().slice(1));

		if (!rest) return undefined;
	}

	if (rest.startsWith(':')) {
		source = parseSource(takeToken().slice(1));

		if (!rest) return undefined;
	}

	const command = takeToken();

	if (!/^(?:[A-Za-z]+|\d{3})$/.test(command)) {
		return undefined;
	}

	const params: string[] = [];

	while (rest) {
		if (rest.startsWith(':')) {
			params.push(rest.slice(1));
			break;
		}

		params.push(takeToken());
	}

	let channel = '';

	if (params[0]?.startsWith('#')) {
		channel = params.shift()!.slice(1);
	}

	return {
		channel,
		command,
		params,
		source,
		tags,
	};
}

function parseTags(component: string): Record<string, string | undefined> {
	const tags: Record<string, string | undefined> = Object.create(null);

	for (const rawTag of component.split(';')) {
		const equals = rawTag.indexOf('=');

		const key = equals === -1 ? rawTag : rawTag.slice(0, equals);
		const value = equals === -1 ? '' : rawTag.slice(equals + 1);

		if (!key) continue;

		tags[key] = value.replace(/\\(.)/g, (_, escaped: string) => {
			switch (escaped) {
				case 's':
					return ' ';
				case ':':
					return ';';
				case 'r':
					return '\r';
				case 'n':
					return '\n';
				case '\\':
					return '\\';
				default:
					return escaped;
			}
		});
	}

	return tags;
}

function parseSource(component: string): RawSource {
	const bang = component.indexOf('!');

	if (bang === -1) {
		return { host: component || 'unknown' };
	}

	const nick = component.slice(0, bang);
	const remainder = component.slice(bang + 1);
	const at = remainder.indexOf('@');

	return {
		nick,
		user: at === -1 ? remainder : remainder.slice(0, at),
		host: at === -1 ? 'unknown' : remainder.slice(at + 1),
	};
}

export type IRC_Message = {
	channel: string;
	command: string;
	params: string[];
	source: RawSource | undefined;
	tags: Record<string, string | undefined> | undefined;
};

type RawSource = {
	host: string;
	nick?: string | undefined;
	user?: string | undefined;
};
