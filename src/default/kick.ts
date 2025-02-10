import Pusher from 'pusher-js';

import {
	type BadgeURLsByNameOrCount,
	type BodyComponent,
	type EmoteURLsByName,
	type Message,
} from './index.js';

type ConnectionState = 'initialized' | 'connecting' | 'connected' | 'unavailable' | 'failed';
type ConnectionStateEvent = { previous: ConnectionState; current: ConnectionState };

type EventCallbackFunctions = {
	message: (message: Message) => unknown;
	subscription: (data: ChatroomsV2Events['SubscriptionEvent']) => unknown;
	gifted: (data: ChatroomV1Events['GiftedSubscriptionsEvent']) => unknown;
	raw_message: (message: ChatMessageEvent) => unknown;
	connection_state_changed: (state: ConnectionStateEvent) => unknown;
};

type EventNames = keyof EventCallbackFunctions;

const DEFAULT_KICK_PUSHER_KEY = '32cbd69e4b950bf97679';

export class KickPusher {
	public kick_pusher_key = DEFAULT_KICK_PUSHER_KEY;
	public channel_name?: string;
	private assets: {
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

	public setBadges(badges: BadgeURLsByNameOrCount) {
		this.assets.badges = { ...this.assets.badges, ...badges };
	}

	public setExternalEmotes(external_emotes: EmoteURLsByName) {
		this.assets.external_emotes = { ...this.assets.external_emotes, ...external_emotes };
	}

	public getStoredBadges() {
		return this.assets.badges;
	}

	public getStoredExternalEmotes() {
		return this.assets.external_emotes;
	}

	public async connect(
		channel?: { channelName?: string },
		get_channel: (channelName: string) => Promise<GetChannelResponse | undefined> = async (
			channelName,
		) => {
			const res = await fetch(`https://kick.com/api/v2/channels/${channelName}`, {
				headers: {
					accept: 'aplication/json',
					'user-agent':
						'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
				},
			});
			const json = await res.json();
			return json as GetChannelResponse | undefined;
		},
	) {
		if (channel?.channelName) this.channel_name = channel.channelName;
		if (!this.channel_name) return console.error('channel_name not specified');

		console.log(`connecting to ${this.channel_name}...`);

		const channel_response = await get_channel(this.channel_name);

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
		this.socket.subscribe(`chatroom_${channel_response.chatroom.id}`);
		this.socket.subscribe(`chatrooms.${channel_response.chatroom.id}.v2`);

		this.socket
			.bind('pusher:subscription_succeeded', () =>
				this.onSubscriptionSuccess('pusher:subscription_succeeded'),
			)
			.bind('App\\Events\\ChatMessageEvent', (data: ChatroomsV2Events['ChatMessageEvent']) =>
				this.onChatMessage(data),
			)
			.bind('App\\Events\\SubscriptionEvent', (data: ChatroomsV2Events['SubscriptionEvent']) =>
				this.onChatSubscription(data),
			)
			.bind(
				'App\\Events\\GiftedSubscriptionsEvent',
				(data: ChatroomV1Events['GiftedSubscriptionsEvent']) => this.onChatGifted(data),
			);

		this.socket.connection.bind('state_change', (state: ConnectionStateEvent) => {
			switch (state.current) {
				case 'connected': {
					this.isConnected = true;
					console.log(`Connected to Kick Pusher (${this.channel_name})!`);
					break;
				}
				case 'connecting': {
					this.isConnected = false;
					console.log(`Connecting to Kick Pusher (${this.channel_name})...`);
					break;
				}
				case 'failed': {
					this.isConnected = false;
					console.log(`Failed to connect to Kick Pusher (${this.channel_name})`);
					break;
				}
				case 'unavailable': {
					this.isConnected = false;
					console.log(`Disconnected from Kick Pusher (${this.channel_name})`);
					break;
				}
				default: {
					this.isConnected = false;
					break;
				}
			}
			this.public_listeners.connection_state_changed?.(state);
		});
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

	private onSubscriptionSuccess(channel: string) {
		console.log(`Subscribed to Channel on Kick Pusher (${channel})`);
	}

	private onChatSubscription(data: ChatroomsV2Events['SubscriptionEvent']) {
		this.public_listeners.subscription?.(data);
	}

	private onChatGifted(data: ChatroomV1Events['GiftedSubscriptionsEvent']) {
		this.public_listeners.gifted?.(data);
	}

	private onChatMessage(data: ChatroomsV2Events['ChatMessageEvent']) {
		this.public_listeners.raw_message?.(data);
		const text = data.content;
		const emote_matches = [...data.content.matchAll(/\[emote:\d+:[a-zA-Z0-9]*\]/g)];

		const body: BodyComponent[] = [];

		emote_matches.forEach((match) => {
			const emote_string = match[0];
			const emote_parts = emote_string.slice(1, emote_string.length - 1).split(':');
			const emote_id = emote_parts[1];
			if (!emote_id) return;

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
		const message: Message = {
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
		};

		if (data.type === 'celebration' && data.metadata?.celebration) {
			message.resubscription = {
				id: data.metadata.celebration.id,
				months: data.metadata.celebration.total_months,
				subscribed_since_timestamp: data.metadata.celebration.created_at,
			};
		}
		this.public_listeners.message?.(message);
	}
}

export interface GetChannelResponse {
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

export interface ChannelLivestream {
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
export interface ChannelChatroom {
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
export interface ChatMessageEvent {
	id: string;
	chatroom_id: number;
	content: string;
	type: 'message' | 'celebration';
	created_at: string;
	metadata?: {
		celebration: {
			created_at: string;
			id: string;
			total_months: number;
			type: 'subscription_renewed';
		};
	};
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

export interface ChannelEvents {
	// {"user_ids":[262477],"username":"Biceus","channel_id":145224}
	ChannelSubscriptionEvent: {
		user_ids: number[];
		username: string;
		channel_id: number;
	};
	// {"leaderboard":[{"user_id":22,"username":"Eddie","quantity":2366},{"user_id":4349824,"username":"TinyTwink","quantity":1878},{"user_id":278971,"username":"Riri_The_Reducer","quantity":1171},{"user_id":703016,"username":"mewtoe","quantity":1143},{"user_id":24981650,"username":"ThailandMonger","quantity":750},{"user_id":5281070,"username":"Annoyinmous","quantity":700},{"user_id":739621,"username":"kfcbelly","quantity":621},{"user_id":367058,"username":"xWendy","quantity":512},{"user_id":35722,"username":"ABZ","quantity":509},{"user_id":723,"username":"Trainwreckstv","quantity":500}],"weekly_leaderboard":[{"user_id":11837402,"username":"BigHornsBigKnives","quantity":5},{"user_id":336982,"username":"krook","quantity":4},{"user_id":1579867,"username":"deadmoney6","quantity":1}],"monthly_leaderboard":[{"user_id":33225,"username":"MRQUICK666","quantity":10},{"user_id":8696811,"username":"Nate09","quantity":10},{"user_id":8561504,"username":"ridorana12","quantity":7},{"user_id":11837402,"username":"BigHornsBigKnives","quantity":5},{"user_id":4239451,"username":"Slippy151","quantity":5},{"user_id":48392334,"username":"isokeith","quantity":5},{"user_id":4341321,"username":"Stonkzz","quantity":5},{"user_id":16894707,"username":"Turtle427","quantity":5},{"user_id":336982,"username":"krook","quantity":4},{"user_id":76184,"username":"complicated","quantity":2}],"gifter_id":11837402,"gifter_username":"BigHornsBigKnives","gifted_quantity":5}
	GiftsLeaderboardUpdated: {
		leaderboard: {
			user_id: number;
			username: string;
			quantity: number;
		}[];
		weekly_leaderboard: {
			user_id: number;
			username: string;
			quantity: number;
		}[];
		monthly_leaderboard: {
			user_id: number;
			username: string;
			quantity: number;
		}[];
		gifter_id: number;
		gifter_username: string;
		gifted_quantity: number;
	};

	// {"channel":{"id":145224,"user_id":146923,"slug":"iceposeidon","is_banned":false,"playback_url":"https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/us-west-2.196233775518.channel.aAMMC00nhtv0.m3u8","name_updated_at":null,"vod_enabled":true,"subscription_enabled":true,"is_affiliate":false,"can_host":true,"chatroom":{"id":145222,"chatable_type":"App\\Models\\Channel","channel_id":145224,"created_at":"2022-12-07T04:42:13.000000Z","updated_at":"2025-02-01T03:27:53.000000Z","chat_mode_old":"public","chat_mode":"public","slow_mode":true,"chatable_id":145224,"followers_mode":true,"subscribers_mode":false,"emotes_mode":false,"message_interval":3,"following_min_duration":6}},"usernames":["Burger2","zigi36","Tallstack","redbug","Real_TOMMO"],"gifter_username":"BigHornsBigKnives"}
	LuckyUsersWhoGotGiftSubscriptionsEvent: {
		channel: {
			id: number;
			user_id: number;
			slug: string;
			is_banned: boolean;
			playback_url: string;
			name_updated_at: unknown;
			vod_enabled: boolean;
			subscription_enabled: boolean;
			is_affiliate: boolean;
			can_host: boolean;
			chatroom: {
				id: number;
				chatable_type: string;
				channel_id: number;
				created_at: string;
				updated_at: string;
				chat_mode_old: string;
				chat_mode: string;
				slow_mode: boolean;
				chatable_id: number;
				followers_mode: boolean;
				subscribers_mode: boolean;
				emotes_mode: boolean;
				message_interval: number;
				following_min_duration: number;
			};
		};
		usernames: string[];
		gifter_username: string;
	};
}

export interface ChatroomsV1Events {
	// {"message":{"id":"3ff9babe-b8ec-468b-aba8-f5c76986e254","numberOfViewers":1877,"optionalMessage":"","createdAt":"2025-02-10T12:03:55.204926Z"},"user":{"id":278343,"username":"Mando","isSuperAdmin":false,"verified":{"id":4867,"channel_id":275681,"created_at":"2023-11-17T20:31:43.000000Z","updated_at":"2023-11-17T20:31:43.000000Z"}}}
	StreamHostedEvent: {
		message: {
			createdAt: string;
			id: string;
			numberOfViewers: number;
			optionalMessage: string;
		};
		user: {
			id: number;
			isSuperAdmin: boolean;
			username: string;
			verified: {
				id: number;
				channel_id: number;
				created_at: string;
				updated_at: string;
			};
		};
	};

	// [message deletion event] unavailable in v1

	// [user ban event] unavailable in v1

	// {"message":{"id":"9b81e836-dfda-4824-87e3-d92e036c65d4","message":null,"type":"info","replied_to":null,"is_info":null,"link_preview":null,"chatroom_id":145222,"role":"user","created_at":1739184786,"action":"subscribe","optional_message":null,"months_subscribed":9,"subscriptions_count":0,"giftedUsers":null},"user":{"id":262477,"username":"Biceus","role":"user","isSuperAdmin":null,"profile_thumb":"https://kick-files-prod.s3.us-west-2.amazonaws.com/images/user/262477/profile_image/conversion/bdb5086d-8a01-457b-bd90-6ff2f4bfabe1-thumb.webp?X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAS3MDRZGPDOOAYROR%2F20250210%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20250210T105306Z&X-Amz-SignedHeaders=host&X-Amz-Expires=300&X-Amz-Signature=5740ccf2430c6b68c04fc38ff06ed47d4785f7c52b0f3855903f184bded22de4","verified":false,"follower_badges":[],"is_subscribed":null,"is_founder":false,"months_subscribed":9,"quantity_gifted":0}}
	ChatMessageSentEvent: {
		message: {
			action: 'subscribe' | 'gift';
			chatroom_id: number;
			created_at: number;
			giftedUsers: {
				username: string;
				monthsSubscribed: number;
			}[];
			id: string;
			is_info: unknown;
			link_preview: unknown;
			message: unknown;
			months_subscribed: number | null;
			optional_message: unknown;
			replied_to: unknown;
			role: 'user';
			subscriptions_count: number;
			type: 'info';
		};
		user: {
			follower_badges: unknown[];
			id: number;
			isSuperAdmin: boolean;
			is_founder: boolean;
			is_subscribed: unknown;
			months_subscribed: number;
			profile_thumb: string;
			quantity_gifted: number;
			role: 'user';
			username: string;
			verified: boolean;
		};
	};
}

export interface ChatroomV1Events {
	// {"chatroom_id":145222,"gifted_usernames":["Burger2","Real_TOMMO","Tallstack","zigi36","redbug"],"gifter_username":"BigHornsBigKnives","gifter_total":5}
	GiftedSubscriptionsEvent: {
		chatroom_id: number;
		gifted_usernames: string[];
		gifter_total: number;
		gifter_username: string;
	};
}

export interface ChatroomsV2Events {
	// {"chatroom_id":145222,"optional_message":"","number_viewers":1877,"host_username":"Mando"}
	StreamHostEvent: {
		chatroom_id: number;
		optional_message: string;
		number_viewers: number;
		host_username: string;
	};

	// {"id":"3b03e221-480a-4c2c-bc65-61573d3336d9","message":{"id":"499500b9-ea91-467f-9034-9eee6e6e164a"},"aiModerated":false,"violatedRules":[]}
	MessageDeletedEvent: {
		id: string;
		message: {
			id: string;
		};
		aiModerated: boolean;
		violatedRules: unknown[];
	};

	// {"id":"6b937ce4-dcc6-4fdf-a113-7c115e5443b1","user":{"id":24580921,"username":"helpinghand","slug":"helpinghand"},"banned_by":{"id":0,"username":"BotRix","slug":"botrix"},"permanent":false,"duration":1,"expires_at":"2025-02-10T12:19:11+00:00"}
	UserBannedEvent: {
		id: string;
		user: {
			id: number;
			username: string;
			slug: string;
		};
		banned_by: {
			id: number;
			username: string;
			slug: string;
		};
		permanent: boolean;
		duration: number;
		expires_at: string;
	};

	// {"chatroom_id":145222,"username":"Biceus","months":9}
	SubscriptionEvent: {
		chatroom_id: number;
		username: string;
		months: number;
	};

	ChatMessageEvent: {
		id: string;
		chatroom_id: number;
		content: string;
		type: 'message' | 'celebration';
		created_at: string;
		metadata?: {
			celebration: {
				created_at: string;
				id: string;
				total_months: number;
				type: 'subscription_renewed';
			};
		};
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
	};
}
