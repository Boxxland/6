const {
  Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  Partials, PermissionFlagsBits,
} = require("discord.js");
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, EndBehaviorType, StreamType,
} = require("@discordjs/voice");
const prism = require("prism-media");

// ─── JSON Database (chat history) ──────────────────────────────────────────
const DB_FILE = path.join(__dirname, "history.json");
const CONFIG_FILE = path.join(__dirname, "config.json");

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}");
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch { return {}; }
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data)); }
function getHistory(key) { return loadDB()[key] || []; }
function saveMessage(key, role, content) {
  const db = loadDB();
  if (!db[key]) db[key] = [];
  db[key].push({ role, parts: [{ text: content }] });
  if (db[key].length > 20) db[key] = db[key].slice(-20);
  saveDB(db);
}
function clearHistory(key) {
  const db = loadDB();
  delete db[key];
  saveDB(db);
}

// ─── Config (per-guild custom prompt) ──────────────────────────────────────
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, "{}");
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch { return {}; }
}
function saveConfig(data) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2)); }

const DEFAULT_NAME = "Skibidri";

function buildSystemPrompt(name) {
  return `คุณคือ ${name} AI เพื่อการศึกษา ในเซิร์ฟเวอร์ Discord
อธิบายเนื้อหาวิชาการได้ทุกระดับ ตั้งแต่ประถมถึงมหาวิทยาลัย
ใช้ภาษาเข้าใจง่าย ยกตัวอย่างประกอบเสมอ รองรับทั้งภาษาไทยและอังกฤษ
ถ้าตอบยาวแบ่งเป็นข้อๆ ถ้าถามว่าคุณคือใคร ให้บอกว่าคุณคือ ${name}`;
}

const DEFAULT_SYSTEM = buildSystemPrompt(DEFAULT_NAME);

function getSystemPrompt(guildId) {
  if (!guildId) return DEFAULT_SYSTEM;
  const config = loadConfig();
  const g = config[guildId] || {};
  if (g.customPrompt) return g.customPrompt;
  if (g.aiName) return buildSystemPrompt(g.aiName);
  return DEFAULT_SYSTEM;
}

// ─── Panel UI ───────────────────────────────────────────────────────────────
function buildPanel(guildId) {
  const config = loadConfig();
  const g = config[guildId] || {};
  const custom = g.customPrompt;
  const aiName = g.aiName;
  const current = custom || (aiName ? buildSystemPrompt(aiName) : DEFAULT_SYSTEM);
  const preview = current.length > 1000 ? current.slice(0, 1000) + "..." : current;

  let statusText;
  if (custom) statusText = "🟢 กำหนดเอง (Prompt แบบเต็ม)";
  else if (aiName) statusText = `🟡 เปลี่ยนชื่อเป็น **${aiName}**`;
  else statusText = `🔵 ค่าเริ่มต้น (${DEFAULT_NAME})`;

  const embed = new EmbedBuilder()
    .setColor(custom ? 0x57f287 : aiName ? 0xfee75c : 0x5865f2)
    .setTitle("⚙️ Skibidri — ตั้งค่า AI")
    .setDescription(`**สถานะ:** ${statusText}\n\n**Prompt ปัจจุบัน:**\n\`\`\`\n${preview}\n\`\`\``)
    .setFooter({ text: "Prompt นี้ใช้ทั้งแชทข้อความและช่องเสียง • ปุ่มต้องเป็น Admin" })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_setname").setLabel("🏷️ เปลี่ยนชื่อ AI").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("panel_setprompt").setLabel("📝 ตั้งค่า Prompt แบบเต็ม").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_reset").setLabel("🔄 รีเซ็ตเป็นค่าเริ่มต้น").setStyle(ButtonStyle.Danger).setDisabled(!custom && !aiName),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ─── Gemini Setup ───────────────────────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Discord Client ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Audio Conversion (Discord ↔ Gemini Live) ──────────────────────────────

// Discord PCM 48kHz stereo → PCM 16kHz mono (for Gemini)
function resampleTo16k(pcmBuffer) {
  const ratio = 3; // 48000 / 16000
  const inputSamples = pcmBuffer.length / 4; // stereo 16-bit
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const src = Math.floor(i * ratio) * 4;
    if (src + 3 >= pcmBuffer.length) break;
    const L = pcmBuffer.readInt16LE(src);
    const R = pcmBuffer.readInt16LE(src + 2);
    output.writeInt16LE(Math.round((L + R) / 2), i * 2);
  }
  return output;
}

// PCM (from Gemini, mono) → PCM 48kHz stereo (for Discord)
function upsampleTo48k(pcmBuffer, inputRate = 24000) {
  const ratio = 48000 / inputRate;
  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.floor(inputSamples * ratio);
  const output = Buffer.alloc(outputSamples * 4);
  for (let i = 0; i < outputSamples; i++) {
    const src = Math.floor(i / ratio) * 2;
    if (src + 1 >= pcmBuffer.length) break;
    const sample = pcmBuffer.readInt16LE(src);
    output.writeInt16LE(sample, i * 4);
    output.writeInt16LE(sample, i * 4 + 2);
  }
  return output;
}

function parseRate(mimeType) {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? parseInt(match[1]) : 24000;
}

// ─── Voice Sessions ─────────────────────────────────────────────────────────
const voiceSessions = new Map();

async function startVoiceSession(message, voiceChannel) {
  const guildId = message.guild.id;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  let audioChunks = [];
  let liveSession = null;
  const playQueue = [];
  let isPlaying = false;

  function playNext() {
    if (isPlaying || playQueue.length === 0) return;
    isPlaying = true;
    const buf = playQueue.shift();
    const readable = Readable.from(buf);
    const resource = createAudioResource(readable, { inputType: StreamType.Raw });
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, () => {
      isPlaying = false;
      playNext();
    });
  }

  const voicePrompt = getSystemPrompt(guildId) + "\n\n(โหมดเสียง: ตอบสั้น กระชับ เป็นธรรมชาติ เหมาะกับการพูดคุยด้วยเสียง)";

  try {
    liveSession = await ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: ["AUDIO"],
        systemInstruction: voicePrompt,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
      callbacks: {
        onopen: () => {
          console.log("✅ Gemini Live connected!");
          message.channel.send("🎙️ **Skibidri Voice** พร้อมแล้ว! พูดได้เลยครับ 🔊");
        },
        onmessage: (msg) => {
          try {
            const parts = msg.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const rate = parseRate(part.inlineData.mimeType);
                const pcm = Buffer.from(part.inlineData.data, "base64");
                audioChunks.push(upsampleTo48k(pcm, rate));
              }
            }
            if (msg.serverContent?.turnComplete && audioChunks.length > 0) {
              const full = Buffer.concat(audioChunks);
              audioChunks = [];
              playQueue.push(full);
              playNext();
            }
          } catch (err) {
            console.error("onmessage error:", err);
          }
        },
        onerror: (err) => {
          console.error("Gemini Live error:", err);
          message.channel.send(`❌ Gemini Live error: ${err.message}`);
        },
        onclose: (e) => console.log("Gemini Live disconnected. Code:", e?.code, "Reason:", e?.reason),
      },
    });
  } catch (err) {
    console.error("Failed to connect Gemini Live:", err);
    message.channel.send(`❌ เชื่อมต่อ Gemini Live ไม่ได้: ${err.message}`);
    connection.destroy();
    return;
  }

  voiceSessions.set(guildId, { connection, player, liveSession });

  connection.once(VoiceConnectionStatus.Ready, () => {
    const receiver = connection.receiver;
    receiver.speaking.on("start", (userId) => {
      const member = message.guild.members.cache.get(userId);
      if (!member || member.user.bot) return;

      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const pcmChunks = [];

      audioStream.pipe(decoder);
      decoder.on("data", (chunk) => pcmChunks.push(chunk));
      decoder.on("end", () => {
        if (pcmChunks.length === 0) return;
        const pcm48k = Buffer.concat(pcmChunks);
        const pcm16k = resampleTo16k(pcm48k);
        if (pcm16k.length < 3200) return;

        const session = voiceSessions.get(guildId);
        if (!session?.liveSession) return;
        try {
          session.liveSession.sendRealtimeInput({
            audio: { data: pcm16k.toString("base64"), mimeType: "audio/pcm;rate=16000" },
          });
        } catch (err) {
          console.error("Error sending audio:", err);
        }
      });
      decoder.on("error", (err) => console.error("Opus decode error:", err));
    });
  });
}

// ─── Auto Panel เมื่อเข้า Server ใหม่ ──────────────────────────────────────
client.on("guildCreate", async (guild) => {
  const config = loadConfig();
  if (config[guild.id]?.welcomed) return; // ป้องกันส่งซ้ำตอน restart

  let channel = guild.systemChannel;
  if (!channel?.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
    channel = guild.channels.cache.find(
      (ch) => ch.isTextBased() && ch.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
    );
  }
  if (!channel) return;

  if (!config[guild.id]) config[guild.id] = {};
  config[guild.id].welcomed = true;
  saveConfig(config);

  const intro = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("👋 สวัสดีครับ! ผม Skibidri")
    .setDescription("ขอบคุณที่เชิญผมเข้า server นี้ครับ! 🎉\nตั้งค่าบุคลิก/Prompt ของ AI ได้ผ่าน panel ด้านล่างเลย (ปุ่มใช้ได้เฉพาะ Admin) หรือพิมพ์ `!help` เพื่อดูคำสั่งทั้งหมดครับ");

  const panel = buildPanel(guild.id);
  await channel.send({ embeds: [intro, ...panel.embeds], components: panel.components });
});

// ─── Ready ──────────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ บอทออนไลน์แล้ว! เข้าสู่ระบบในชื่อ ${client.user.tag}`);
});

// ─── Buttons / Modal (Prompt Panel) ────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.guild) return;

  if (interaction.isButton() && ["panel_setprompt", "panel_reset", "panel_setname"].includes(interaction.customId)) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "❌ ปุ่มนี้ใช้ได้เฉพาะ Admin ครับ", ephemeral: true });
    }

    if (interaction.customId === "panel_setname") {
      const config = loadConfig();
      const currentName = config[interaction.guildId]?.aiName || DEFAULT_NAME;
      const modal = new ModalBuilder().setCustomId("modal_setname").setTitle("🏷️ ตั้งชื่อ AI");
      const input = new TextInputBuilder()
        .setCustomId("ai_name")
        .setLabel("ชื่อของ AI (เช่น Skibidri, หมูเด้ง, นานะ)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(30)
        .setValue(currentName);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "panel_setprompt") {
      const config = loadConfig();
      const current = config[interaction.guildId]?.customPrompt || DEFAULT_SYSTEM;
      const modal = new ModalBuilder().setCustomId("modal_setprompt").setTitle("📝 ตั้งค่า Prompt ใหม่");
      const input = new TextInputBuilder()
        .setCustomId("prompt_text")
        .setLabel("System Prompt (กำหนดบุคลิก/พฤติกรรม AI)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(2000)
        .setValue(current.slice(0, 2000));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "panel_reset") {
      const config = loadConfig();
      if (config[interaction.guildId]) {
        delete config[interaction.guildId].customPrompt;
        delete config[interaction.guildId].aiName;
      }
      saveConfig(config);
      return interaction.update(buildPanel(interaction.guildId));
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === "modal_setname") {
    const name = interaction.fields.getTextInputValue("ai_name").trim();
    if (!name) return interaction.reply({ content: "❌ ชื่อห้ามว่างครับ", ephemeral: true });

    const config = loadConfig();
    if (!config[interaction.guildId]) config[interaction.guildId] = {};
    config[interaction.guildId].aiName = name;
    delete config[interaction.guildId].customPrompt;
    saveConfig(config);

    await interaction.reply({ content: `✅ เปลี่ยนชื่อ AI เป็น **${name}** แล้วครับ! (มีผลกับแชทใหม่และตอนเข้าช่องเสียงครั้งต่อไป)`, ephemeral: true });
    try { await interaction.message?.edit(buildPanel(interaction.guildId)); } catch {}
  }

  if (interaction.isModalSubmit() && interaction.customId === "modal_setprompt") {
    const text = interaction.fields.getTextInputValue("prompt_text").trim();
    if (!text) return interaction.reply({ content: "❌ Prompt ห้ามว่างครับ", ephemeral: true });

    const config = loadConfig();
    if (!config[interaction.guildId]) config[interaction.guildId] = {};
    config[interaction.guildId].customPrompt = text;
    saveConfig(config);

    await interaction.reply({ content: "✅ ตั้งค่า Prompt ใหม่สำเร็จ! (มีผลกับแชทใหม่และการเข้าช่องเสียงครั้งต่อไป)", ephemeral: true });
    try { await interaction.message?.edit(buildPanel(interaction.guildId)); } catch {}
  }
});

// ─── Messages ───────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user);
  const isDM = !message.guild;
  const content = message.content.trim();
  const historyKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;

  // ---- !help ----
  if (content === "!help") {
    return message.reply(`📚 **คำสั่งทั้งหมด**

🤖 \`!ask <คำถาม>\` — ถาม Skibidri AI
🎨 \`!image <คำอธิบาย>\` — สร้างรูปภาพ
🗑️ \`!clear\` — ล้างประวัติสนทนา
⚙️ \`!panel\` — ตั้งค่า Prompt ของ AI (Admin)
🎙️ \`!join\` — เข้าช่องเสียง + คุยกับ Gemini Live
👋 \`!leave\` — ออกจากช่องเสียง
❓ \`!help\` — แสดงคำสั่งทั้งหมด

หรือจะ **mention บอท** / **DM** ตรงๆ ก็ได้เลยครับ!`);
  }

  // ---- !clear ----
  if (content === "!clear") {
    clearHistory(historyKey);
    return message.reply("🗑️ ล้างประวัติสนทนาแล้วครับ!");
  }

  // ---- !panel ----
  if (content === "!panel") {
    if (!message.guild) return message.reply("❌ คำสั่งนี้ใช้ได้เฉพาะใน server ครับ");
    return message.channel.send(buildPanel(message.guild.id));
  }

  // ---- !image ----
  if (content.startsWith("!image ")) {
    const prompt = content.slice(7).trim();
    if (!prompt) return message.reply("❌ ใส่คำอธิบายรูปด้วยครับ");
    await message.channel.sendTyping();
    try {
      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
      const res = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const attachment = new AttachmentBuilder(Buffer.from(res.data), { name: "image.png" });
      return message.reply({ content: `🎨 **${prompt}**`, files: [attachment] });
    } catch (err) {
      console.error(err);
      return message.reply("❌ สร้างรูปไม่สำเร็จ ลองใหม่อีกครั้งครับ");
    }
  }

  // ---- !join ----
  if (content === "!join") {
    const vc = message.member?.voice.channel;
    if (!vc) return message.reply("❌ เข้าช่องเสียงก่อนนะครับ!");
    if (voiceSessions.has(message.guild.id)) return message.reply("❌ บอทอยู่ในช่องเสียงแล้วครับ!");
    await message.reply("⏳ กำลังเชื่อมต่อ Gemini Live...");
    await startVoiceSession(message, vc);
    return;
  }

  // ---- !leave ----
  if (content === "!leave") {
    const s = voiceSessions.get(message.guild?.id);
    if (!s) return message.reply("❌ บอทไม่ได้อยู่ในช่องเสียงครับ!");
    try { s.liveSession?.close(); } catch {}
    s.connection.destroy();
    voiceSessions.delete(message.guild.id);
    return message.reply("👋 ออกจากช่องเสียงแล้วครับ");
  }

  // ---- AI Chat ----
  let userMessage = "";
  if (content.startsWith("!ask ")) {
    userMessage = content.slice(5).trim();
  } else if (isMentioned || isDM) {
    userMessage = content.replace(/<@!?\d+>/g, "").trim();
  } else {
    return;
  }

  if (!userMessage) return message.reply("สวัสดีครับ! พิมพ์ `!help` เพื่อดูคำสั่งทั้งหมดได้เลยครับ 😊");

  try {
    await message.channel.sendTyping();

    const history = getHistory(historyKey);
    const chat = ai.chats.create({
      model: "gemma-4-31b-it",
      config: { systemInstruction: getSystemPrompt(message.guild?.id) },
      history,
    });

    const response = await chat.sendMessage({ message: userMessage });
    const replyText = response.text;

    saveMessage(historyKey, "user", userMessage);
    saveMessage(historyKey, "model", replyText);

    if (replyText.length <= 2000) {
      await message.reply(replyText);
    } else {
      const chunks = replyText.match(/.{1,2000}/gs) || [];
      for (const chunk of chunks) await message.channel.send(chunk);
    }
  } catch (error) {
    console.error("Error:", error);
    await message.reply("❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งครับ");
  }
});

if (!process.env.DISCORD_TOKEN || !process.env.GEMINI_API_KEY) {
  console.error("❌ กรุณาตั้งค่า DISCORD_TOKEN และ GEMINI_API_KEY!");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
