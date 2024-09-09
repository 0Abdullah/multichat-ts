import Pusher from 'pusher-js';

import {
	type BadgeURLsByNameOrCount,
	type BodyComponent,
	type EmoteURLsByName,
	type Message,
} from './index.js';

type EventCallbackFunctions = {
	message: (message: Message) => unknown;
	raw_message: (message: ChatMessageEvent) => unknown;
};

type EventNames = keyof EventCallbackFunctions;

const DEFAULT_KICK_PUSHER_KEY = '32cbd69e4b950bf97679';

export class KickPusher {
	public kick_pusher_key = DEFAULT_KICK_PUSHER_KEY;
	public channel_name?: string;
	public assets: {
		external_emotes: EmoteURLsByName;
		badges: BadgeURLsByNameOrCount;
	} = {
		external_emotes: {},
		badges: {
			founder: '/svgs/badges/default-kick/founder.svg',
			moderator: '/svgs/badges/default-kick/moderator.svg',
			og: '/svgs/badges/default-kick/og.svg',
			sub_gifter: {
				1: '/svgs/badges/default-kick/sub-gifter-blue.svg',
				25: '/svgs/badges/default-kick/sub-gifter-purple.svg',
				50: '/svgs/badges/default-kick/sub-gifter-red.svg',
				100: '/svgs/badges/default-kick/sub-gifter-yellow.svg',
				200: '/svgs/badges/default-kick/sub-gifter-green.svg',
			},
			verified: '/svgs/badges/default-kick/verified.svg',
			vip: '/svgs/badges/default-kick/vip.svg',
			broadcaster: '/svgs/badges/default-kick/broadcaster.svg',
			staff: '/svgs/badges/default-kick/staff.svg',
		},
	};

	private public_listeners: Partial<EventCallbackFunctions> = {};

	public socket?: Pusher;
	public isConnected = false;

	public async connect(channel?: { channelName?: string }) {
		if (channel?.channelName) this.channel_name = channel.channelName;
		if (!this.channel_name) return console.error('channel_name not specified');

		console.log(`connecting to ${this.channel_name}...`);

		const channel_response = await fetch(`https://kick.com/api/v2/channels/${this.channel_name}`)
			.then((res) => res.json())
			.then((json) => json as GetChannelResponse | undefined);

		if (!channel_response) return console.error('Failed to connect to Kick.com chat');

		channel_response.subscriber_badges.forEach((subscriber_badge) => {
			this.assets.badges['subscriber'] = {
				...(this.assets.badges['subscriber'] ?? {}),
				[subscriber_badge.months]: subscriber_badge.badge_image.src,
			};
		});

		this.disconnect();

		this.socket = new Pusher(this.kick_pusher_key, {
			cluster: 'us2',
		});

		/*
		| 'App\\Events\\ChatMessageEvent'
		| 'App\\Events\\ChatroomClearEvent'
		| 'App\\Events\\ChatroomUpdatedEvent'
		| 'App\\Events\\GiftedSubscriptionsEvent'
		| 'App\\Events\\MessageDeletedEvent'
		| 'App\\Events\\PinnedMessageCreatedEvent'
		| 'App\\Events\\PinnedMessageDeletedEvent'
		| 'App\\Events\\PollDeleteEvent'
		| 'App\\Events\\PollUpdateEvent'
		| 'App\\Events\\StreamHostEvent'
		| 'App\\Events\\SubscriptionEvent'
		| 'App\\Events\\UserBannedEvent'
		| 'App\\Events\\UserUnbannedEvent'
		*/
		this.socket
			.subscribe(`chatrooms.${channel_response.chatroom.id}.v2`)
			.bind('pusher:subscription_succeeded', () => this.onSubscriptionSuccess())
			.bind('App\\Events\\ChatMessageEvent', (data: ChatMessageEvent) => this.onChatMessage(data));
	}

	public disconnect() {
		this.socket?.disconnect();
		this.socket?.unbind_all();
	}

	public on<EventName extends EventNames>(
		event_name: EventName,
		callback_fn: EventCallbackFunctions[EventName],
	) {
		this.public_listeners[event_name] = callback_fn;
	}

	private onSubscriptionSuccess() {
		console.log(`Connected to Kick Pusher (${this.channel_name})`);
	}

	private onChatMessage(data: ChatMessageEvent) {
		this.public_listeners.raw_message?.(data);
		const text = data.content;
		const emote_matches = [...data.content.matchAll(/\[emote:\d+:[a-zA-Z0-9]*\]/g)];
		console.log(emote_matches);

		const body: BodyComponent[] = [];

		emote_matches.forEach((match) => {
			const emote_string = match[0];
			const emote_parts = emote_string.slice(1, emote_string.length - 1).split(':');
			const emote_id = emote_parts[1];
			if (!emote_id) return;
			console.log(emote_id);

			body.push({
				type: 'emote',
				start_inclusive: match.index,
				end_exclusive: match.index + emote_string.length,
				url: `https://files.kick.com/emotes/${emote_id}/fullsize`,
			});
		});

		body.sort((a, b) => a.start_inclusive - b.start_inclusive);

		const old_body_length = body.length;

		if (old_body_length > 0) {
			body.forEach((segment, index) => {
				const previous_segment = body[index - 1];

				const text_start_inclusive =
					previous_segment?.end_exclusive !== undefined ? previous_segment.end_exclusive + 1 : 0;
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

		this.public_listeners.message?.({
			id: data.id,
			user: {
				id: `${data.sender.id}`,
				username: data.sender.slug ?? data.sender.username.toLowerCase(),
				display_name: data.sender.username,
				roles: {},
				color: data.sender.identity.color,
				badges: data.sender.identity.badges.flatMap((badge) => {
					let badge_url: string | undefined = undefined;

					const badge_url_or_counts = this.assets.badges[badge.type];
					const badge_count = badge.count;

					if (typeof badge_url_or_counts === 'string') badge_url = badge_url_or_counts;
					else if (typeof badge_url_or_counts === 'object' && badge_count !== undefined) {
						const badge_entry_by_count = Object.entries(badge_url_or_counts)
							.sort(([a_min_count], [b_min_count]) => Number(a_min_count) - Number(b_min_count))
							.find(([min_count]) => badge_count >= Number(min_count));
						if (badge_entry_by_count) badge_url = badge_entry_by_count[1];
					}

					if (!badge_url) return [];
					return {
						set_id: badge.type,
						url: badge_url,
						info: String(badge.count),
					};
				}),
			},
			body,
			channel: {
				room_id: String(data.chatroom_id),
				name: this.channel_name ?? 'unknown',
			},
			raw_text: data.content,
			timestamp_sent: Date.parse(data.created_at),
		});
	}
}

interface GetChannelResponse {
	id: number;
	user_id: number;
	slug: string;
	is_banned: boolean;
	playback_url?: string;
	vod_enabled: boolean;
	subscription_enabled: boolean;
	followers_count: number;
	following?: boolean;
	subscription?: unknown;
	subscriber_badges: Array<{
		id: number;
		channel_id: number;
		months: number;
		badge_image: {
			srcset: string;
			src: string;
		};
	}>;
	banner_image?: {
		url: string;
	};
	livestream?: ChannelLivestream;
	role?: unknown;
	muted: boolean;
	follower_badges: unknown[];
	offline_banner_image: unknown;
	verified: boolean;
	recent_categories: Array<{
		id: number;
		category_id: number;
		name: string;
		slug: string;
		tags: string[];
		description?: string;
		deleted_at: unknown;
		viewers: number;
		banner: {
			responsive: string;
			url: string;
		};
		category: {
			id: number;
			name: string;
			slug: string;
			icon: string;
		};
	}>;
	can_host: boolean;
	user: {
		id: number;
		username: string;
		agreed_to_terms: true;
		email_verified_at: Date;
		bio?: string;
		country?: string;
		state?: string;
		city?: string;
		instagram?: string;
		twitter?: string;
		youtube?: string;
		discord?: string;
		tiktok?: string;
		facebook?: string;
		profile_pic?: string;
	};
	chatroom: ChannelChatroom;
	ascending_links?: Array<{
		id: number;
		channel_id: number;
		description: string;
		link: string;
		created_at: Date;
		updated_at: Date;
		order: number;
		title: string;
	}>;
}

interface ChannelLivestream {
	id: number;
	slug: string;
	channel_id: number;
	created_at: Date;
	session_title: string;
	is_live: boolean;
	risk_level_id: unknown;
	start_time: Date;
	source: unknown;
	twitch_channel: unknown;
	duration: number;
	language: string;
	is_mature: boolean;
	viewer_count: number;
	thumbnail: {
		url: string;
	};
	categories: Array<{
		id: number;
		category_id: number;
		name: string;
		slug: string;
		tags: string[];
		description?: string;
		deleted_at: unknown;
		viewers: number;
		category: {
			id: number;
			name: string;
			slug: string;
			icon: string;
		};
	}>;
	tags: unknown[];
}
interface ChannelChatroom {
	id: number;
	chatable_type: string;
	channel_id: string;
	created_at: Date;
	updated_at: Date;
	chat_mode_old: string;
	chat_mode: string;
	slow_mode: boolean;
	chatable_id: number;
	followers_mode: boolean;
	subscribers_mode: boolean;
	emotes_mode: boolean;
	message_interval: number;
	following_min_duration: number;
}
interface ChatMessageEvent {
	id: string;
	chatroom_id: number;
	content: string;
	type: string;
	created_at: string;
	sender: {
		id: number;
		username: string;
		slug?: string;
		identity: {
			color: string;
			badges: Array<{
				type: string;
				text: string;
				count?: number;
			}>;
		};
	};
}
