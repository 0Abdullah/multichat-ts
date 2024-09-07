# multichat-ts

Receive type-safe realtime events for chat-related messages on multiple platforms (Twitch, Kick)

## Usage

```sh
pnpm install multichat-ts # or (npm, bun, deno, etc) install
```

```ts
import { TwitchIRC, KickPusher } from 'multichat-ts';

const twitch_chat = new TwitchIRC();
const kick_chat = new KickPusher();

twitch_chat.connect({
	channelName: 'piratesoftware',
});

kick_chat.connect({
	channelName: 'xqc',
});

// set custom badge assets or external emotes (ffz, bttv, 7tv, etc)
twitch_chat.assets.external_emotes = {
	OMEGALUL: 'https://cdn.frankerfacez.com/emoticon/128054/1',
};

twitch_chat.on('message', (message) => {
	console.log('new twitch message', message.raw_text, message);
});

kick_chat.on('message', (message) => {
	console.log('new twitch message', message.raw_text, message);
});
```

### Example usage with Svelte 5

```svelte
<script lang="ts">
	import { TwitchIRC, type Message, KickPusher } from 'multichat-ts';

	let messages: Message[] = $state([]);

	const twitch_chat = new TwitchIRC();

	twitch_chat.connect({
		channelName: 'piratesoftware'
	});

	twitch_chat.on('message', (message) => {
		messages.push(message);
	});

	twitch_chat.on('clear_messages', (data) => {
		if (data.user !== undefined) {
			messages.filter((message) => message.user.id !== data.user!.id);
		} else {
			messages.filter((message) => message.channel.room_id !== data.channel.room_id);
		}
	});

	twitch_chat.on('delete_message', (message_data) => {
		messages.filter((message) => message.id !== message_data.id);
	});
</script>

<ul>
	{#each messages as message}
		<li>{message.user.display_name}: {message.raw_text}</li>
	{/each}
</ul>
```

MIT
