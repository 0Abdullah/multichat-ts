export * from './kick.js';
export * from './twitch.js';

export type Message = {
	body: BodyComponent[];
	channel: {
		room_id: string;
		name: string;
	};
	id: string;
	raw_text: string;
	timestamp_sent: number;
	user: {
		badges: Badge[];
		color: string;
		id: string;
		username: string;
		display_name: string;
		roles: {
			[role in 'vip' | 'moderator' | 'turbo' | 'admin' | 'global_moderator' | 'staff']?: boolean;
		};
	};
};

export type ClearMessages = {
	channel: {
		room_id: string;
		name: string;
	};
	user?: {
		id: string;
		username: string;
	};
	timeout_duration_seconds?: number | undefined;
	timestamp_sent: number;
};

export type DeleteMessage = {
	channel: {
		room_id?: string;
		name: string;
	};
	user?: {
		username: string;
	};
	id: string;
	raw_text: string;
	timestamp_sent: number;
};

type EventData = {
	subscription: {
		months: number;
		streak?: number;
		subscription_plan: {
			type: 'prime' | 1000 | 2000 | 3000;
			name: string;
		};
		gift_upgrade?: {
			gift_total: number;
			promo_name: string;
			sender: {
				username: string;
				display_name: string;
			};
		};
	};
	gift: {
		months: number;
		recipient: {
			id: string;
			username: string;
			display_name: string;
		};
		subscription_plan: {
			type: 'prime' | 1000 | 2000 | 3000;
			name: string;
		};
	};
	raid: {
		sender: {
			username: string;
			display_name: string;
			viewer_count: number;
		};
	};
};

export type Event = {
	[E in keyof EventData]: {
		type: E;
		body: BodyComponent[];
		channel: {
			room_id: string;
			name: string;
		};
		id: string;
		raw_text: string;
		system_message: string;
		timestamp_sent: number;
		user: {
			badges: Badge[];
			color: string;
			id: string;
			username: string;
			display_name: string;
			roles: {
				[role in
					| 'moderator'
					| 'subscriber'
					| 'turbo'
					| 'admin'
					| 'global_moderator'
					| 'staff']?: boolean;
			};
		};
		data: EventData[E];
	};
}[keyof EventData];

export type BodyComponentEmote = {
	end_exclusive: number;
	start_inclusive: number;
	type: 'emote';
	url: string;
};

export type BodyComponent =
	| {
			end_exclusive: number;
			label: string;
			start_inclusive: number;
			type: 'link';
			url: string;
	  }
	| {
			end_exclusive: number;
			start_inclusive: number;
			text: string;
			type: 'text';
	  }
	| BodyComponentEmote;

type Badge = {
	info?: string | undefined;
	set_id: string;
	url: string;
};

export type BadgeURLsByNameOrCount = {
	[badge_name: string]:
		| string
		| {
				[badge_count: number]: string;
		  };
};

type StringOrAny = '*' | (string & Record<never, never>);

export type BadgeURLsBySetIDAndVersionIDOrAny = {
	[badge_set_id: string]: Record<StringOrAny, string>;
};

export type EmoteURLsByName = {
	[emote_name: string]: string;
};
