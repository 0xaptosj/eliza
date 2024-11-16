import {
    AudioPlayer,
    AudioReceiveStream,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnection,
    createAudioPlayer,
    createAudioResource,
    getVoiceConnection,
    joinVoiceChannel,
} from "@discordjs/voice";
import {
    BaseGuildVoiceChannel,
    ChannelType,
    Client,
    Guild,
    GuildMember,
    VoiceChannel,
    VoiceState,
} from "discord.js";
import EventEmitter from "events";
import prism from "prism-media";
import { Readable, pipeline } from "stream";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import { generateMessageResponse } from "@ai16z/eliza/src/generation.ts";
import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    ISpeechService,
    ITranscriptionService,
    Memory,
    ModelClass,
    Service,
    ServiceType,
    State,
    UUID,
} from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";

export function getWavHeader(
    audioLength: number,
    sampleRate: number,
    channelCount: number = 1,
    bitsPerSample: number = 16
): Buffer {
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + audioLength, 4); // Length of entire file in bytes minus 8
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16); // Length of format data
    wavHeader.writeUInt16LE(1, 20); // Type of format (1 is PCM)
    wavHeader.writeUInt16LE(channelCount, 22); // Number of channels
    wavHeader.writeUInt32LE(sampleRate, 24); // Sample rate
    wavHeader.writeUInt32LE(
        (sampleRate * bitsPerSample * channelCount) / 8,
        28
    ); // Byte rate
    wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32); // Block align ((BitsPerSample * Channels) / 8)
    wavHeader.writeUInt16LE(bitsPerSample, 34); // Bits per sample
    wavHeader.write("data", 36); // Data chunk header
    wavHeader.writeUInt32LE(audioLength, 40); // Data chunk size
    return wavHeader;
}

import { messageCompletionFooter } from "@ai16z/eliza/src/parsing.ts";

const discordVoiceHandlerTemplate =
    `# Task: Generate conversational voice dialog for {{agentName}}.
About {{agentName}}:
{{bio}}

# Attachments
{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{actions}}

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}. Include an optional action if appropriate. {{actionNames}}
` + messageCompletionFooter;

// These values are chosen for compatibility with picovoice components
const DECODE_FRAME_SIZE = 1024;
const DECODE_SAMPLE_RATE = 16000;

// Buffers all audio
export class AudioMonitor {
    private readable: Readable;
    private buffers: Buffer[] = [];
    private maxSize: number;
    private lastFlagged: number = -1;
    private ended: boolean = false;

    constructor(
        readable: Readable,
        maxSize: number,
        callback: (buffer: Buffer) => void
    ) {
        this.readable = readable;
        this.maxSize = maxSize;
        this.readable.on("data", (chunk: Buffer) => {
            //console.log('AudioMonitor got data');
            if (this.lastFlagged < 0) {
                this.lastFlagged = this.buffers.length;
            }
            this.buffers.push(chunk);
            const currentSize = this.buffers.reduce(
                (acc, cur) => acc + cur.length,
                0
            );
            while (currentSize > this.maxSize) {
                this.buffers.shift();
                this.lastFlagged--;
            }
        });
        this.readable.on("end", () => {
            console.log("AudioMonitor ended");
            this.ended = true;
            if (this.lastFlagged < 0) return;
            callback(this.getBufferFromStart());
            this.lastFlagged = -1;
        });
        this.readable.on("speakingStopped", () => {
            if (this.ended) return;
            console.log("Speaking stopped");
            if (this.lastFlagged < 0) return;
            callback(this.getBufferFromStart());
        });
        this.readable.on("speakingStarted", () => {
            if (this.ended) return;
            console.log("Speaking started");
            this.reset();
        });
    }

    stop() {
        this.readable.removeAllListeners("data");
        this.readable.removeAllListeners("end");
        this.readable.removeAllListeners("speakingStopped");
        this.readable.removeAllListeners("speakingStarted");
    }

    isFlagged() {
        return this.lastFlagged >= 0;
    }

    getBufferFromFlag() {
        if (this.lastFlagged < 0) {
            return null;
        }
        const buffer = Buffer.concat(this.buffers.slice(this.lastFlagged));
        return buffer;
    }

    getBufferFromStart() {
        const buffer = Buffer.concat(this.buffers);
        return buffer;
    }

    reset() {
        this.buffers = [];
        this.lastFlagged = -1;
    }

    isEnded() {
        return this.ended;
    }
}

export class VoiceManager extends EventEmitter {
    private currentTranscriptionId: string | null = null;
    private userStates: Map<
        string,
        {
            buffers: Buffer[];
            totalLength: number;
            lastActive: number;
            transcriptionText: string;
        }
    > = new Map();
    private activeAudioPlayer: AudioPlayer | null = null;
    private client: Client;
    private runtime: IAgentRuntime;
    private streams: Map<string, Readable> = new Map();
    private connections: Map<string, VoiceConnection> = new Map();
    private activeMonitors: Map<
        string,
        { channel: BaseGuildVoiceChannel; monitor: AudioMonitor }
    > = new Map();

    constructor(client: any) {
        super();
        this.client = client.client;
        this.runtime = client.runtime;
    }

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
        const oldChannelId = oldState.channelId;
        const newChannelId = newState.channelId;
        const member = newState.member;
        if (!member) return;
        if (member.id === this.client.user?.id) {
            return;
        }

        // Ignore mute/unmute events
        if (oldChannelId === newChannelId) {
            return;
        }

        // User leaving a channel where the bot is present
        if (oldChannelId && this.connections.has(oldChannelId)) {
            this.stopMonitoringMember(member.id);
        }

        // User joining a channel where the bot is present
        if (newChannelId && this.connections.has(newChannelId)) {
            await this.monitorMember(
                member,
                newState.channel as BaseGuildVoiceChannel
            );
        }
    }

    async joinChannel(channel: BaseGuildVoiceChannel) {
        const oldConnection = getVoiceConnection(channel.guildId as string);
        if (oldConnection) {
            try {
                oldConnection.destroy();
            } catch (error) {
                console.error("Error leaving voice channel:", error);
            }
        }
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator as any,
            selfDeaf: false,
            selfMute: false,
        });

        for (const [, member] of channel.members) {
            if (member && !member.user.bot) {
                this.monitorMember(member, channel);
            }
        }

        connection.receiver.speaking.on("start", async (userId: string) => {
            let user = channel.members.get(userId);
            if (!user) {
                try {
                    user = await channel.guild.members.fetch(userId);
                } catch (error) {
                    console.error("Failed to fetch user:", error);
                }
            }
            if (user && !user?.user.bot) {
                this.monitorMember(user as GuildMember, channel);
                this.streams.get(userId)?.emit("speakingStarted");
            }
        });

        connection.receiver.speaking.on("end", async (userId: string) => {
            const user = channel.members.get(userId);
            if (!user?.user.bot) {
                this.streams.get(userId)?.emit("speakingStopped");
            }
        });
    }

    private async monitorMember(
        member: GuildMember,
        channel: BaseGuildVoiceChannel
    ) {
        const userId = member.id;
        const userName = member.user.username;
        const name = member.user.displayName;
        const connection = getVoiceConnection(member.guild.id);
        const receiveStream = connection?.receiver.subscribe(userId, {
            autoDestroy: true,
            emitClose: true,
        });
        if (!receiveStream || receiveStream.readableLength === 0) {
            return;
        }
        const opusDecoder = new prism.opus.Decoder({
            channels: 1,
            rate: DECODE_SAMPLE_RATE,
            frameSize: DECODE_FRAME_SIZE,
        });
        const volumeBuffer: number[] = [];
        const VOLUME_WINDOW_SIZE = 30;
        const SPEAKING_THRESHOLD = 0.05;
        opusDecoder.on("data", (pcmData: Buffer) => {
            // Monitor the audio volume while the agent is speaking.
            // If the average volume of the user's audio exceeds the defined threshold, it indicates active speaking.
            // When active speaking is detected, stop the agent's current audio playback to avoid overlap.

            if (this.activeAudioPlayer) {
                const samples = new Int16Array(
                    pcmData.buffer,
                    pcmData.byteOffset,
                    pcmData.length / 2
                );
                const rms = Math.sqrt(
                    samples.reduce((sum, sample) => sum + sample * sample, 0) /
                        samples.length
                );
                const volume = rms / 32768;
                volumeBuffer.push(volume);
                if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
                    volumeBuffer.shift();
                }
                const avgVolume =
                    volumeBuffer.reduce((sum, v) => sum + v, 0) /
                    VOLUME_WINDOW_SIZE;

                if (avgVolume > SPEAKING_THRESHOLD) {
                    volumeBuffer.length = 0;
                    this.cleanupAudioPlayer(this.activeAudioPlayer);
                }
            }
        });

        pipeline(
            receiveStream as AudioReceiveStream,
            opusDecoder as any,
            (err: Error | null) => {
                if (err) {
                    console.log(`Opus decoding pipeline error: ${err}`);
                }
            }
        );
        this.streams.set(userId, opusDecoder);
        this.connections.set(userId, connection as VoiceConnection);
        opusDecoder.on("error", (err: any) => {
            console.log(`Opus decoding error: ${err}`);
        });
        const errorHandler = (err: any) => {
            console.log(`Opus decoding error: ${err}`);
        };
        const streamCloseHandler = () => {
            console.log(`voice stream from ${member?.displayName} closed`);
            this.streams.delete(userId);
            this.connections.delete(userId);
        };
        const closeHandler = () => {
            console.log(`Opus decoder for ${member?.displayName} closed`);
            opusDecoder.removeListener("error", errorHandler);
            opusDecoder.removeListener("close", closeHandler);
            receiveStream?.removeListener("close", streamCloseHandler);
        };
        opusDecoder.on("error", errorHandler);
        opusDecoder.on("close", closeHandler);
        receiveStream?.on("close", streamCloseHandler);

        this.client.emit(
            "userStream",
            userId,
            name,
            userName,
            channel,
            opusDecoder
        );
    }

    leaveChannel(channel: BaseGuildVoiceChannel) {
        const connection = this.connections.get(channel.id);
        if (connection) {
            connection.destroy();
            this.connections.delete(channel.id);
        }

        // Stop monitoring all members in this channel
        for (const [memberId, monitorInfo] of this.activeMonitors) {
            if (
                monitorInfo.channel.id === channel.id &&
                memberId !== this.client.user?.id
            ) {
                this.stopMonitoringMember(memberId);
            }
        }

        console.log(`Left voice channel: ${channel.name} (${channel.id})`);
    }

    stopMonitoringMember(memberId: string) {
        const monitorInfo = this.activeMonitors.get(memberId);
        if (monitorInfo) {
            monitorInfo.monitor.stop();
            this.activeMonitors.delete(memberId);
            this.streams.delete(memberId);
            console.log(`Stopped monitoring user ${memberId}`);
        }
    }

    async handleGuildCreate(guild: Guild) {
        console.log(`Joined guild ${guild.name}`);
        // this.scanGuild(guild);
    }

    async handleUserStream(
        userId: UUID,
        name: string,
        userName: string,
        channel: BaseGuildVoiceChannel,
        audioStream: Readable
    ) {
        console.log(`Starting audio monitor for user: ${userId}`);
        const channelId = channel.id;
        if (!this.userStates.has(userId)) {
            this.userStates.set(userId, {
                buffers: [],
                totalLength: 0,
                lastActive: Date.now(),
                transcriptionText: "",
            });
        }

        const state = this.userStates.get(userId);

        const processBuffer = async (buffer: Buffer) => {
            try {
                state!.buffers.push(buffer);
                state!.totalLength += buffer.length;
                state!.lastActive = Date.now();

                const DEBOUNCE_TRANSCRIPTION_THRESHOLD = 1500; // wait for 1 seconds of silence

                clearTimeout(state!["debounceTimeout"]);
                state!["debounceTimeout"] = setTimeout(async () => {
                    await this.processTranscription(
                        userId,
                        channelId,
                        channel,
                        name,
                        userName
                    );
                }, DEBOUNCE_TRANSCRIPTION_THRESHOLD);
            } catch (error) {
                console.error(
                    `Error processing buffer for user ${userId}:`,
                    error
                );
            }
        };

        const monitor = new AudioMonitor(
            audioStream,
            10000000,
            async (buffer) => {
                if (!buffer) {
                    console.error("Received empty buffer");
                    return;
                }
                await processBuffer(buffer);
            }
        );
    }

    private async processTranscription(
        userId: UUID,
        channelId: string,
        channel: BaseGuildVoiceChannel,
        name: string,
        userName: string
    ) {
        const state = this.userStates.get(userId);
        if (!state || state.buffers.length === 0) return;
        const transcriptionId = Date.now().toString();
        this.currentTranscriptionId = transcriptionId;

        try {
            const inputBuffer = Buffer.concat(state.buffers, state.totalLength);
            state.buffers.length = 0; // Clear the buffers
            state.totalLength = 0;

            // Convert Opus to WAV
            const wavBuffer = await this.convertOpusToWav(inputBuffer);

            console.log("Starting transcription...");

            const transcriptionText = await this.runtime
                .getService(ServiceType.TRANSCRIPTION)
                .getInstance<ITranscriptionService>()
                .transcribe(wavBuffer);

            function invalidText(text: string): boolean {
                if (text.includes("[BLANK_AUDIO]")) {
                    return true;
                }
                // if (text.length < 5 && text.toLowerCase().includes("you")) { // not sure what is this
                //     return true;
                // }
                if (text === null) {
                    return true;
                }
                return false;
            }

            if (transcriptionText && !invalidText(transcriptionText)) {
                state.transcriptionText += transcriptionText;
            }

            if (state.transcriptionText.length) {
                this.cleanupAudioPlayer(this.activeAudioPlayer);
                const finalText = state.transcriptionText;
                state.transcriptionText = "";
                await this.handleTranscriptionResult(
                    finalText,
                    userId,
                    channelId,
                    channel,
                    name,
                    userName,
                    transcriptionId
                );
            }
        } catch (error) {
            console.error(
                `Error transcribing audio for user ${userId}:`,
                error
            );
        }
    }

    private async handleTranscriptionResult(
        text: string,
        userId: UUID,
        channelId: string,
        channel: BaseGuildVoiceChannel,
        name: string,
        userName: string,
        transcriptionId: string
    ) {
        try {
            const roomId = stringToUuid(channelId + "-" + this.runtime.agentId);
            const userIdUUID = stringToUuid(userId);

            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                userName,
                name,
                "discord"
            );

            let state = await this.runtime.composeState(
                {
                    agentId: this.runtime.agentId,
                    content: { text: text, source: "Discord" },
                    userId: userIdUUID,
                    roomId,
                },
                {
                    discordChannel: channel,
                    discordClient: this.client,
                    agentName: this.runtime.character.name,
                }
            );

            if (text && text.startsWith("/")) {
                return null;
            }

            const memory = {
                id: stringToUuid(channelId + "-voice-message-" + Date.now()),
                agentId: this.runtime.agentId,
                content: {
                    text: text,
                    source: "discord",
                    url: channel.url,
                },
                userId: userIdUUID,
                roomId,
                embedding: embeddingZeroVector,
                createdAt: Date.now(),
            };

            if (!memory.content.text) {
                return { text: "", action: "IGNORE" };
            }

            await this.runtime.messageManager.createMemory(memory);

            state = await this.runtime.updateRecentMessageState(state);

            const shouldIgnore = await this._shouldIgnore(memory);

            if (shouldIgnore) {
                return { text: "", action: "IGNORE" };
            }

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates
                        ?.discordVoiceHandlerTemplate ||
                    this.runtime.character.templates?.messageHandlerTemplate ||
                    discordVoiceHandlerTemplate,
            });

            const responseContent = await this._generateResponse(
                memory,
                state,
                context
            );

            const callback: HandlerCallback = async (content: Content) => {
                console.log("callback content: ", content);
                const { roomId } = memory;

                const responseMemory: Memory = {
                    id: stringToUuid(
                        memory.id + "-voice-response-" + Date.now()
                    ),
                    agentId: this.runtime.agentId,
                    userId: this.runtime.agentId,
                    content: {
                        ...content,
                        user: this.runtime.character.name,
                        inReplyTo: memory.id,
                    },
                    roomId,
                    embedding: embeddingZeroVector,
                };

                if (responseMemory.content.text?.trim()) {
                    await this.runtime.messageManager.createMemory(
                        responseMemory
                    );
                    state = await this.runtime.updateRecentMessageState(state);
                    if (transcriptionId === this.currentTranscriptionId) {
                        // Ensure that only the latest transcription triggers the Eleven Labs API
                        // to avoid overlapping audio responses and unnecessary expenses
                        const responseStream = await this.runtime
                            .getService(ServiceType.SPEECH_GENERATION)
                            .getInstance<ISpeechService>()
                            .generate(this.runtime, content.text);

                        if (responseStream) {
                            await this.playAudioStream(
                                userId,
                                responseStream as Readable
                            );
                        }
                    }
                    await this.runtime.evaluate(memory, state);
                } else {
                    console.warn("Empty response, skipping");
                }
                return [responseMemory];
            };

            const responseMemories = await callback(responseContent);

            const response = responseContent;

            const content = (response.responseMessage ||
                response.content ||
                response.message) as string;

            if (!content) {
                return null;
            }

            console.log("responseMemories: ", responseMemories);

            await this.runtime.processActions(
                memory,
                responseMemories,
                state,
                callback
            );
        } catch (error) {
            console.error("Error processing transcribed text:", error);
        }
    }

    private async convertOpusToWav(pcmBuffer: Buffer): Promise<Buffer> {
        try {
            // Generate the WAV header
            const wavHeader = getWavHeader(
                pcmBuffer.length,
                DECODE_SAMPLE_RATE
            );

            // Concatenate the WAV header and PCM data
            const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

            return wavBuffer;
        } catch (error) {
            console.error("Error converting PCM to WAV:", error);
            throw error;
        }
    }

    private async _generateResponse(
        message: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        response.source = "discord";

        if (!response) {
            console.error("No response from generateMessageResponse");
            return;
        }

        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId: userId,
            roomId,
            type: "response",
        });

        return response;
    }

    private async _shouldIgnore(message: Memory): Promise<boolean> {
        console.log("message: ", message);
        console.log("message.content: ", message.content);
        // if the message is 3 characters or less, ignore it
        if ((message.content as Content).text.length < 3) {
            return true;
        }

        const loseInterestWords = [
            // telling the bot to stop talking
            "shut up",
            "stop",
            "dont talk",
            "silence",
            "stop talking",
            "be quiet",
            "hush",
            "stfu",
            "stupid bot",
            "dumb bot",

            // offensive words
            "fuck",
            "shit",
            "damn",
            "suck",
            "dick",
            "cock",
            "sex",
            "sexy",
        ];
        if (
            (message.content as Content).text.length < 50 &&
            loseInterestWords.some((word) =>
                (message.content as Content).text?.toLowerCase().includes(word)
            )
        ) {
            return true;
        }

        const ignoreWords = ["k", "ok", "bye", "lol", "nm", "uh"];
        if (
            (message.content as Content).text?.length < 8 &&
            ignoreWords.some((word) =>
                (message.content as Content).text?.toLowerCase().includes(word)
            )
        ) {
            return true;
        }

        return false;
    }

    async scanGuild(guild: Guild) {
        const channels = (await guild.channels.fetch()).filter(
            (channel) => channel?.type == ChannelType.GuildVoice
        );
        let chosenChannel: BaseGuildVoiceChannel | null = null;

        for (const [, channel] of channels) {
            const voiceChannel = channel as BaseGuildVoiceChannel;
            if (
                voiceChannel.members.size > 0 &&
                (chosenChannel === null ||
                    voiceChannel.members.size > chosenChannel.members.size)
            ) {
                chosenChannel = voiceChannel;
            }
        }

        if (chosenChannel != null) {
            this.joinChannel(chosenChannel);
        }
    }

    async playAudioStream(userId: UUID, audioStream: Readable) {
        const connection = this.connections.get(userId);
        if (connection == null) {
            console.log(`No connection for user ${userId}`);
            return;
        }

        this.cleanupAudioPlayer(this.activeAudioPlayer);

        const audioPlayer = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            },
        });
        this.activeAudioPlayer = audioPlayer;
        connection.subscribe(audioPlayer);

        const audioStartTime = Date.now();

        const resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
        });
        audioPlayer.play(resource);

        const handleError = (err: any) => {
            console.log(`Audio player error: ${err}`);
        };
        const handleStateChange = (
            oldState: any,
            newState: { status: string }
        ) => {
            if (newState.status == "idle") {
                const idleTime = Date.now();
                console.log(
                    `Audio playback took: ${idleTime - audioStartTime}ms`
                );
            }
        };

        audioPlayer.on("stateChange", handleStateChange);
        audioPlayer.on("error", handleError);
    }

    cleanupAudioPlayer(audioPlayer: AudioPlayer) {
        if (!audioPlayer) return;

        audioPlayer.stop();
        audioPlayer.removeAllListeners();
        if (audioPlayer === this.activeAudioPlayer) {
            this.activeAudioPlayer = null;
        }
    }

    async handleJoinChannelCommand(interaction: any) {
        const channelId = interaction.options.get("channel")?.value as string;
        if (!channelId) {
            await interaction.reply("Please provide a voice channel to join.");
            return;
        }
        const guild = interaction.guild;
        if (!guild) {
            return;
        }
        const voiceChannel = interaction.guild.channels.cache.find(
            (channel: VoiceChannel) =>
                channel.id === channelId &&
                channel.type === ChannelType.GuildVoice
        );

        if (!voiceChannel) {
            await interaction.reply("Voice channel not found!");
            return;
        }

        try {
            this.joinChannel(voiceChannel as BaseGuildVoiceChannel);
            await interaction.reply(
                `Joined voice channel: ${voiceChannel.name}`
            );
        } catch (error) {
            console.error("Error joining voice channel:", error);
            await interaction.reply("Failed to join the voice channel.");
        }
    }

    async handleLeaveChannelCommand(interaction: any) {
        const connection = getVoiceConnection(interaction.guildId as any);

        if (!connection) {
            await interaction.reply("Not currently in a voice channel.");
            return;
        }

        try {
            connection.destroy();
            await interaction.reply("Left the voice channel.");
        } catch (error) {
            console.error("Error leaving voice channel:", error);
            await interaction.reply("Failed to leave the voice channel.");
        }
    }
}
