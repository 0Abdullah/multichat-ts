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
};

type EventNames = keyof EventCallbackFunctions;

export class TwitchIRC {
	public channel_name?: string;
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

	public socket?: WebSocket;
	public ws?: WebSocket | undefined;

	constructor(ws?: WebSocket) {
		this.ws = ws;
	}

	public setBadges(badges: BadgeURLsBySetIDOrSetIDAndVersion) {
		this.assets.badges = { ...badges, ...this.assets.badges };
	}

	public setExternalEmotes(external_emotes: EmoteURLsByName) {
		this.assets.external_emotes = { ...external_emotes, ...this.assets.external_emotes };
	}

	public getStoredBadges() {
		return this.assets.badges;
	}

	public getStoredExternalEmotes() {
		return this.assets.external_emotes;
	}

	public connect(channel?: { channelName?: string }) {
		if (channel?.channelName) this.channel_name = channel.channelName;
		if (!this.channel_name) return console.error('channel_name not specified');

		console.log(`connecting to ${this.channel_name}...`);

		this.socket?.close();

		this.socket = new WebSocket('wss://irc-ws.chat.twitch.tv', null, {
			WebSocket: this.ws,
		});
		this.socket.onopen = () => this.onOpen();
		this.socket.onclose = () => this.onClose();
		this.socket.onmessage = (event) => this.onMessage(event);
	}

	public disconnect() {
		this.socket?.close();
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

	private onOpen() {
		this.send('CAP REQ :twitch.tv/commands twitch.tv/tags');
		this.send(`PASS ${ANONYMOUS_IRC_PASS}`);
		this.send(`NICK ${ANONYMOUS_IRC_LOGIN}`);
		this.send(`JOIN #${this.channel_name}`);

		console.log(`Connected to Twitch IRC as Anonymous (${this.channel_name})`);

		if (this.ping.interval) clearInterval(this.ping.interval);
		this.sendPing();
		this.ping.interval = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
	}

	private onClose() {
		clearInterval(this.ping.interval);
		clearTimeout(this.ping.timeout);
	}

	private sendPing() {
		this.send('PING');
		this.ping.lastSentTimestamp = Date.now();

		if (this.ping.timeout) clearTimeout(this.ping.timeout);
		this.ping.timeout = setTimeout(() => {
			console.error('PING Timeout, reconnecting...');
			this.connect();
		}, PING_TIMEOUT_MS);
	}

	private send(irc_message: string) {
		if (!this.isConnected()) {
			throw new Error('Not connected');
		}
		this.socket?.send(irc_message);
	}

	private onMessage(event: MessageEvent) {
		if (!event.data) return;
		const lines = String(event.data).trim().split('\r\n');
		const messages = lines.map(parseIRCLine);
		messages.forEach((message) => {
			this.public_listeners.raw_message?.(message);
			switch (message.command) {
				case 'PONG': {
					if (!this.ping.lastSentTimestamp) return console.error('got PONG without sending PING');
					clearInterval(this.ping.timeout);
					this.latency = Date.now() - this.ping.lastSentTimestamp;
					this.ping.lastSentTimestamp = undefined;
					break;
				}
				case 'PING': {
					this.send('PONG');
					break;
				}
				case 'CLEARCHAT': {
					const { channel, tags } = message;
					if (!tags) return;

					this.public_listeners.clear_messages?.({
						channel: {
							name: channel,
							room_id: tags['room-id'] ?? 'unknown',
						},
						timestamp_sent: Number(tags['tmi-sent-ts']),
						timeout_duration_seconds: tags['ban-duration']
							? Number(tags['ban-duration'])
							: undefined,
					});
					break;
				}
				case 'PRIVMSG': {
					const { channel, params, tags } = message;
					if (!tags || !tags['user-id'] || !tags['id'] || !tags['room-id']) return;

					const text = params[0];
					if (!text) return;

					const body: BodyComponent[] = [];

					tags.emotes?.split('/').forEach((raw_emote_string) => {
						const [emote_id, raw_emote_positions_string] = raw_emote_string.split(':');
						if (!emote_id || !raw_emote_positions_string) return;

						const raw_emote_positions = raw_emote_positions_string.split(',');
						raw_emote_positions.forEach((raw_emote_position) => {
							const [emote_start, emote_end] = raw_emote_position.split('-');
							if (!emote_start || !emote_end) return;

							body.push({
								type: 'emote',
								start_inclusive: +emote_start,
								end_exclusive: +emote_end + 1,
								url: `https://static-cdn.jtvnw.net/emoticons/v2/${emote_id}/default/dark/1.0`,
							});
						});
					});

					body.sort((a, b) => a.start_inclusive - b.start_inclusive);

					const old_body_length = body.length;

					if (old_body_length > 0) {
						body.forEach((segment, index) => {
							const previous_segment = body[index - 1];

							const text_start_inclusive =
								previous_segment?.end_exclusive !== undefined
									? previous_segment.end_exclusive + 1
									: 0;
							const text_end_exclusive = Math.max(0, segment.start_inclusive);

							if (text_end_exclusive - text_start_inclusive > 0) {
								body.push({
									type: 'text',
									text: text.slice(text_start_inclusive, text_end_exclusive),
									start_inclusive: text_start_inclusive,
									end_exclusive: text_end_exclusive,
								});
							}
							if (index === old_body_length - 1 && segment.end_exclusive < text.length - 1) {
								body.push({
									type: 'text',
									text: text.slice(segment.end_exclusive),
									start_inclusive: segment.end_exclusive,
									end_exclusive: text.length,
								});
							}
						});
					} else {
						body.push({
							type: 'text',
							text,
							start_inclusive: 0,
							end_exclusive: text.length,
						});
					}

					body.sort((a, b) => a.start_inclusive - b.start_inclusive);

					const badge_info: {
						[set_id: string]: string;
					} = {};
					tags['badge-info']?.split(',').forEach((badge) => {
						const [set_id, info] = badge.split('/');
						if (!set_id || !info) return;

						badge_info[set_id] = info;
					});

					this.public_listeners.message?.({
						body: body,
						channel: {
							room_id: tags['room-id'],
							name: channel,
						},
						id: tags.id,
						raw_text: text,
						timestamp_sent: Number(tags['tmi-sent-ts']),
						user: {
							badges:
								tags.badges?.split(',').flatMap((badge) => {
									const [set_id, version] = badge.split('/');
									if (!set_id || !version) return [];

									const storedBadge = this.assets.badges[set_id];
									if (!storedBadge) return [];

									const url = typeof storedBadge === 'object' ? storedBadge[version] : storedBadge;
									if (!url) return [];

									return {
										info: badge_info[set_id],
										set_id,
										url,
									};
								}) ?? [],
							color: tags.color ?? '#FFFFFF',
							id: tags['user-id'],
							username: (tags['display-name'] ?? 'Unknown').toLowerCase(),
							display_name: tags['display-name'] ?? 'Unknown',
							roles: {},
						},
					});
					break;
				}
			}
		});
	}
}

function parseIRCLine(line: string): IRC_Message {
	const components = line.split(' ');
	let componentIndex = 0;

	let raw_tags_component: string | undefined;
	let source: RawSource | undefined;

	if (components[componentIndex]!.startsWith('@')) {
		raw_tags_component = components[componentIndex]!.slice(1);
		componentIndex++;
	}

	if (components[componentIndex]!.startsWith(':')) {
		source = parseSource(components[componentIndex]!.slice(1));
		componentIndex++;
	}

	const command = components[componentIndex]! as CommandType;
	componentIndex++;

	let channel: string = '';
	if (components[componentIndex]!.startsWith('#')) channel = components[componentIndex]!.slice(1);
	componentIndex++;

	const params: string[] = [];
	while (components[componentIndex] !== undefined) {
		const param = components[componentIndex]!;
		if (param.startsWith(':')) {
			params.push(components.slice(componentIndex).join(' ').slice(1));
			componentIndex = -1;
		} else {
			params.push(param);
			componentIndex++;
		}
	}

	const tags = raw_tags_component ? parseTags(raw_tags_component, command) : undefined;

	return {
		channel,
		command,
		params,
		source,
		tags,
	};
}

function parseTags(component: string, command: CommandType): AllRawTags {
	// const tags = Object.fromEntries(RAW_TAGS[command].map((key) => [key, undefined])) as AllRawTags
	const tags = {} as AllRawTags;

	component.split(';').forEach((raw_tag) => {
		const [key, value] = raw_tag.split('=') as [AllRawTagsKeys, string];
		// console.log([key, value])
		if (RAW_TAGS[command].findIndex((el) => el === key) === -1)
			console.warn(`[${command}] Unknown Tag: ${raw_tag}`);
		// if (value.length)
		tags[key] = value;
	});

	return tags;
}

function parseSource(component: string): RawSource {
	let user: string | undefined = undefined;
	let host: string | undefined = component;
	let nick: string | undefined = undefined;

	if (component.includes('!')) [nick, host] = component.split('!');
	if (host?.includes('@')) [user, host] = host.split('@');

	return {
		host: host ?? 'unknown',
		nick,
		user,
	};
}

type IRC_Message = {
	[C in CommandType]: {
		channel: string;
		command: C;
		params: string[];
		source: RawSource | undefined;
		tags: SpecificRawTags<C> | undefined;
	};
}[CommandType];

type RAW_TAGS = typeof RAW_TAGS;
type CommandType = keyof RAW_TAGS;
type AllRawTagsKeys = RAW_TAGS[CommandType][number];
type AllRawTags = Record<AllRawTagsKeys, string | undefined>;
type SpecificRawTags<Command extends CommandType> = Record<
	RAW_TAGS[Command][number],
	string | undefined
>;

type RawSource = {
	host: string;
	nick?: string | undefined;
	user?: string | undefined;
};

const RAW_TAGS = {
	CLEARCHAT: ['ban-duration', 'room-id', 'target-user-id', 'tmi-sent-ts'],
	CLEARMSG: ['login', 'room-id', 'target-msg-id', 'tmi-sent-ts'],

	GLOBALUSERSTATE: [
		'badge-info',
		'badges',
		'color',
		'display-name',
		'emote-sets',
		'turbo',
		'user-id',
		'user-type',
	],

	HOSTTARGET: [],

	NOTICE: ['msg-id', 'target-user-id'],

	PART: [],

	PING: [],

	PONG: [],

	PRIVMSG: [
		'badge-info',
		'badges',
		'bits',
		'color',
		'display-name',
		'emotes',
		'emote-only',
		'id',
		'mod',
		'custom-reward-id',
		'reply-thread-parent-display-name',
		'reply-thread-parent-user-id',
		'pinned-chat-paid-amount',
		'pinned-chat-paid-currency',
		'pinned-chat-paid-exponent',
		'pinned-chat-paid-level',
		'pinned-chat-paid-is-system-message',
		'reply-parent-msg-id',
		'reply-parent-user-id',
		'reply-parent-user-login',
		'reply-parent-display-name',
		'reply-parent-msg-body',
		'reply-thread-parent-msg-id',
		'reply-thread-parent-user-login',
		'room-id',
		'subscriber',
		'tmi-sent-ts',
		'turbo',
		'user-id',
		'user-type',
		'vip',
		...[
			// undocumented
			'client-nonce',
			'first-msg',
			'flags',
			'returning-chatter',
		],
	],
	RECONNECT: [],
	ROOMSTATE: ['emote-only', 'followers-only', 'r9k', 'room-id', 'slow', 'subs-only'],
	USERNOTICE: [
		'badge-info',
		'badges',
		'color',
		'display-name',
		'emotes',
		'id',
		'login',
		'mod',
		'msg-id',
		'room-id',
		'subscriber',
		'system-msg',
		'tmi-sent-ts',
		'turbo',
		'user-id',
		'user-type',
		'vip',
		'flags',
		...[
			// Only subscription/raid related notices
			'msg-param-cumulative-months',
			'msg-param-displayName',
			'msg-param-login',
			'msg-param-multimonth-duration',
			'msg-param-multimonth-tenure',
			'msg-param-was-gifted=false',
			'msg-param-months',
			'msg-param-promo-gift-total',
			'msg-param-promo-name',
			'msg-param-recipient-display-name',
			'msg-param-recipient-id',
			'msg-param-recipient-user-name',
			'msg-param-sender-login',
			'msg-param-sender-name',
			'msg-param-should-share-streak',
			'msg-param-streak-months',
			'msg-param-sub-plan',
			'msg-param-sub-plan-name',
			'msg-param-viewerCount',
			'msg-param-ritual-name',
			'msg-param-threshold',
			'msg-param-gift-months',
			'msg-param-was-gifted',
			'msg-param-community-gift-id',
			'msg-param-mass-gift-count',
			'msg-param-origin-id',
		],
	],
	USERSTATE: [
		'badge-info',
		'badges',
		'color',
		'display-name',
		'emote-sets',
		'id',
		'mod',
		'subscriber',
		'turbo',
		'user-type',
	],
	WHISPER: [
		'badges',
		'color',
		'display-name',
		'emotes',
		'message-id',
		'thread-id',
		'turbo',
		'user-id',
		'user-type',
	],
} as const;
