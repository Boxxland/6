const {
  Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  Partials, PermissionFlagsBits,
  SlashCommandBuilder, REST, Routes,
} = require("discord.js");
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { PassThrough } = require("stream");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, EndBehaviorType, StreamType,
} = require("@discordjs/voice");
const prism = require("prism-media");

// บังคับ resolve DNS เป็น IPv4 ก่อน — แก้ปัญหา @discordjs/voice ค้างที่ signalling/connecting บน Termux
require("dns").setDefaultResultOrder("ipv4first");

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
const CHAT_MODEL = "gemini-3.5-flash-lite";

// แปลงไฟล์แนบ → ส่วนข้อมูลสำหรับ Gemini (รูป/PDF → inlineData, ไฟล์ข้อความ → แทรกเป็น text)
async function attachmentToPart(attachment) {
  const type = attachment.contentType || "";
  const name = attachment.name || "";
  if (type.startsWith("image/") || type === "application/pdf") {
    const res = await axios.get(attachment.url, { responseType: "arraybuffer" });
    return { inlineData: { mimeType: type, data: Buffer.from(res.data).toString("base64") } };
  }
  if (type.startsWith("text/") || /\.(txt|md|csv|json|js|py|html|css|log)$/i.test(name)) {
    const res = await axios.get(attachment.url, { responseType: "text" });
    return { text: `\n\n[ไฟล์แนบ: ${name}]\n${String(res.data).slice(0, 8000)}` };
  }
  return null;
}

// ห่อข้อความยาวเป็นไฟล์ .txt แนบ Discord (กันข้อความเกิน 2000 ตัวอักษรโดนตัดสแปมหลายข้อความ)
function textToFile(text, filename = `skibidri-${Date.now()}.txt`) {
  return new AttachmentBuilder(Buffer.from(text, "utf-8"), { name: filename });
}

// ── PDF จริง (ใช้ตอนสั่ง /pdf) ──────────────────────────────────────────────
// วางไฟล์ฟอนต์ไว้ในโฟลเดอร์ fonts/ ตามชื่อด้านล่าง แล้วเลือกจาก dropdown ตอนสั่ง /pdf ได้เลย
const FONT_MAP = {
  sarabun: path.join(__dirname, "fonts", "Sarabun-Regular.ttf"),
  itim: path.join(__dirname, "fonts", "Itim-Regular.ttf"),
  kanit: path.join(__dirname, "fonts", "Kanit-Regular.ttf"),
};
const DEFAULT_FONT = FONT_MAP.sarabun;

function textToPDF(text, title = "Skibidri", fontSource = null) {
  return new Promise((resolve, reject) => {
    const font = fontSource || DEFAULT_FONT;
    if (typeof font === "string" && !fs.existsSync(font)) {
      return reject(new Error(`ไม่พบไฟล์ฟอนต์ (${path.basename(font)}) — เอาไฟล์ .ttf ไปวางไว้ที่โฟลเดอร์ fonts/ ก่อนครับ`));
    }
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      doc.font(font); // รับได้ทั้ง path (string) และ Buffer (ฟอนต์ที่แนบมาเอง)
    } catch (err) {
      return reject(new Error(`โหลดฟอนต์ไม่สำเร็จ (ไฟล์อาจเสียหรือไม่ใช่ .ttf/.otf ที่ถูกต้อง): ${err.message}`));
    }
    doc.fontSize(18).text(title, { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(text, { align: "left" });
    doc.end();
  });
}

function pdfToFile(buffer, filename = `skibidri-${Date.now()}.pdf`) {
  return new AttachmentBuilder(buffer, { name: filename });
}

async function askAI(userMessage, historyKey, guildId, attachments = [], retries = 2) {
  const fileParts = [];
  for (const att of attachments) {
    try {
      const part = await attachmentToPart(att);
      if (part) fileParts.push(part);
    } catch (err) {
      console.error("attachmentToPart error:", err);
    }
  }

  // gemini-3.5-flash-lite รองรับ text/image/PDF ในตัวเดียว → ส่งเป็น parts array เดียวเลย
  const parts = [{ text: userMessage || "ช่วยอธิบายไฟล์ที่แนบมาให้หน่อยครับ" }, ...fileParts];

  const history = getHistory(historyKey);
  const chat = ai.chats.create({
    model: CHAT_MODEL,
    config: { systemInstruction: getSystemPrompt(guildId) },
    history,
  });
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await chat.sendMessage({ message: parts });
      const replyText = response.text;
      saveMessage(historyKey, "user", userMessage || "[ส่งไฟล์/รูปภาพ]");
      saveMessage(historyKey, "model", replyText);
      return replyText;
    } catch (err) {
      if (err?.status === 500 && i < retries) {
        console.log(`⚠️ Gemini 500 error, retry ${i + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
}

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

async function startVoiceSession(ctx, voiceChannel) {
  const guildId = ctx.guild.id;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: ctx.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    console.log("🔌 Voice connection หลุด → เคลียร์ session");
    const s = voiceSessions.get(guildId);
    voiceSessions.delete(guildId); // ลบก่อน close กัน onclose เข้าใจผิดว่าต้อง reconnect
    try { s?.liveSession?.close(); } catch {}
    try { connection.destroy(); } catch {}
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    voiceSessions.delete(guildId);
  });

  connection.on("stateChange", (oldState, newState) => {
    console.log(`🔄 Voice connection: ${oldState.status} → ${newState.status}`);
  });

  // ลงทะเบียน listener ก่อน connect Gemini เสมอ ป้องกัน Ready event หลุด (Gemini connect ช้ากว่า Discord)
  connection.once(VoiceConnectionStatus.Ready, () => {
    console.log("✅ Voice connection Ready! เริ่มดักเสียง...");
    const receiver = connection.receiver;
    receiver.speaking.on("start", (userId) => {
      const member = ctx.guild.members.cache.get(userId);
      if (!member || member.user.bot) return;
      console.log(`🎤 ${member.user.tag} กำลังพูด...`);

      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

      audioStream.pipe(decoder);
      // ส่งเสียงแบบ stream ทันทีที่ได้แต่ละ chunk แทนรอบัฟเฟอร์ทั้งประโยคก่อนส่ง
      // Gemini Live มี VAD ในตัวอยู่แล้ว ตรวจจับจังหวะพูดจบเองได้ ไม่ต้องรอ local silence 800ms ก่อนเริ่มส่ง
      decoder.on("data", (chunk) => {
        const pcm16k = resampleTo16k(chunk);
        if (pcm16k.length === 0) return;

        const session = voiceSessions.get(guildId);
        if (!session?.liveSession) return;
        try {
          session.liveSession.sendRealtimeInput({
            audio: { data: pcm16k.toString("base64"), mimeType: "audio/pcm;rate=16000" },
          });
        } catch (err) {
          console.error("Error sending audio chunk:", err);
        }
      });
      decoder.on("end", () => {
        console.log(`🔇 ${member.user.tag} หยุดพูด`);
      });
      decoder.on("error", (err) => console.error("Opus decode error:", err));
    });
  });

  let currentStream = null;
  function getStream() {
    if (!currentStream) {
      currentStream = new PassThrough();
      player.play(createAudioResource(currentStream, { inputType: StreamType.Raw }));
    }
    return currentStream;
  }
  function endStream() {
    if (currentStream) { currentStream.end(); currentStream = null; }
  }

  let liveSession;
  try {
    liveSession = await connectGeminiLive(ctx, guildId, getStream, endStream, player);
  } catch (err) {
    connection.destroy();
    setTimeout(() => process.exit(1), 1000);
    return;
  }

  voiceSessions.set(guildId, { connection, player, liveSession });
}

// เชื่อมต่อ Gemini Live — แยกออกมาเป็นฟังก์ชันเดี่ยวเพื่อให้เรียกซ้ำได้ตอน reconnect
// (Gemini Live session มี limit ~10 นาที/connection แล้วหลุดเอง ต้องต่อใหม่ด้วย session handle)
async function connectGeminiLive(ctx, guildId, getStream, endStream, player, resumeHandle = null) {
  const connectStartTime = Date.now();
  let handle = resumeHandle;
  const voicePrompt = getSystemPrompt(guildId) + "\n\n(โหมดเสียง: ตอบสั้น กระชับ เป็นธรรมชาติ เหมาะกับการพูดคุยด้วยเสียง)";

  try {
    const liveSession = await ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: ["AUDIO"],
        systemInstruction: voicePrompt,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
        // เปิด session resumption — {} = session ใหม่, {handle} = ขอต่อ session เดิม
        sessionResumption: handle ? { handle } : {},
      },
      callbacks: {
        onopen: () => {
          console.log(resumeHandle ? "🔄 Gemini Live reconnected!" : "✅ Gemini Live connected!");
          if (!resumeHandle) ctx.channel.send("🎙️ **Skibidri Voice** พร้อมแล้ว! พูดได้เลยครับ 🔊");
        },
        onmessage: (msg) => {
          try {
            if (msg.sessionResumptionUpdate?.newHandle) {
              handle = msg.sessionResumptionUpdate.newHandle;
              const s = voiceSessions.get(guildId);
              if (s) s.resumeHandle = handle;
            }
            if (msg.goAway) {
              console.log(`⚠️ Gemini Live goAway ได้รับสัญญาณ ใกล้หลุด (timeLeft: ${msg.goAway.timeLeft ?? "?"})`);
            }
            const parts = msg.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const rate = parseRate(part.inlineData.mimeType);
                const pcm = Buffer.from(part.inlineData.data, "base64");
                getStream().write(upsampleTo48k(pcm, rate));
              }
            }
            if (msg.serverContent?.turnComplete) {
              endStream();
            }
            if (msg.serverContent?.interrupted) {
              player.stop();
              endStream();
            }
          } catch (err) {
            console.error("onmessage error:", err);
          }
        },
        onerror: (err) => {
          console.error("Gemini Live error:", err);
        },
        onclose: (e) => {
          console.log("Gemini Live disconnected. Code:", e?.code, "Reason:", e?.reason);

          // ถ้า /leave ไปแล้วหรือ voice connection หลุดไปแล้ว จะไม่มี entry ใน voiceSessions → ไม่ต้อง reconnect
          if (!voiceSessions.has(guildId)) return;

          const connectedDuration = Date.now() - connectStartTime;
          if (connectedDuration < 5000) {
            console.log("⚠️ หลุดเร็วเกินไป (< 5s) → restart บอท");
            ctx.channel.send("⚠️ Gemini Live หลุดเร็วผิดปกติ 🔄 กำลัง restart บอท...");
            setTimeout(() => process.exit(1), 1000);
            return;
          }

          // หลุดแบบปกติ (session timeout ~10 นาที หรือเน็ตสะดุด) → ต่อ session เดิมด้วย handle
          console.log(`🔄 Session หลุด กำลังต่อใหม่... (มี resume handle: ${handle ? "มี" : "ไม่มี"})`);
          setTimeout(() => {
            connectGeminiLive(ctx, guildId, getStream, endStream, player, handle)
              .then((newLiveSession) => {
                const s = voiceSessions.get(guildId);
                if (s) s.liveSession = newLiveSession;
              })
              .catch((err) => console.error("Reconnect Gemini Live ไม่สำเร็จ:", err));
          }, 1000);
        },
      },
    });
    return liveSession;
  } catch (err) {
    console.error("Failed to connect Gemini Live:", err);
    ctx.channel.send(`❌ เชื่อมต่อ Gemini Live ไม่ได้: ${err.message}`);
    throw err;
  }
}

// ─── Slash Commands ─────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("แสดงคำสั่งทั้งหมด"),
  new SlashCommandBuilder().setName("clear").setDescription("ล้างประวัติการสนทนากับ AI"),
  new SlashCommandBuilder().setName("panel").setDescription("เปิด panel ตั้งค่า AI (Admin)"),
  new SlashCommandBuilder().setName("image").setDescription("สร้างรูปภาพด้วย AI")
    .addStringOption(opt => opt.setName("prompt").setDescription("คำอธิบายรูปภาพ").setRequired(true)),
  new SlashCommandBuilder().setName("ask").setDescription("ถาม Skibidri AI")
    .addStringOption(opt => opt.setName("question").setDescription("คำถามของคุณ").setRequired(true))
    .addAttachmentOption(opt => opt.setName("file").setDescription("รูปภาพ/PDF/ไฟล์ข้อความให้ AI ดู").setRequired(false)),
  new SlashCommandBuilder().setName("pdf").setDescription("ให้ AI เขียนแล้วส่งเป็นไฟล์ PDF")
    .addStringOption(opt => opt.setName("prompt").setDescription("สั่งให้เขียนอะไร เช่น เรื่องสั้น, สรุป, จดหมาย").setRequired(true))
    .addStringOption(opt => opt.setName("font")
      .setDescription("เลือกฟอนต์ (ไม่เลือก = Sarabun)")
      .setRequired(false)
      .addChoices(
        { name: "Sarabun (ทางการ)", value: "sarabun" },
        { name: "Itim (ลายมือ น่ารัก)", value: "itim" },
        { name: "Kanit (โมเดิร์น)", value: "kanit" },
      )),
  new SlashCommandBuilder().setName("join").setDescription("ให้บอทเข้าช่องเสียง + คุยกับ Gemini Live"),
  new SlashCommandBuilder().setName("leave").setDescription("ให้บอทออกจากช่องเสียง"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("กำลังลงทะเบียน slash commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log("ลงทะเบียน slash commands สำเร็จ!");
  } catch (err) {
    console.error("ลงทะเบียน commands ล้มเหลว:", err);
  }
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
    .setDescription("ขอบคุณที่เชิญผมเข้า server นี้ครับ! 🎉\nตั้งค่าบุคลิก/Prompt ของ AI ได้ผ่าน panel ด้านล่างเลย (ปุ่มใช้ได้เฉพาะ Admin) หรือใช้ `/help` เพื่อดูคำสั่งทั้งหมดครับ");

  const panel = buildPanel(guild.id);
  await channel.send({ embeds: [intro, ...panel.embeds], components: panel.components });
});

// ─── Ready ──────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ บอทออนไลน์แล้ว! เข้าสู่ระบบในชื่อ ${client.user.tag}`);
  await registerCommands();
});

// ─── Interactions ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── Slash Commands ──────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    await interaction.deferReply(); // ให้ Discord เวลาตอบสนองถึง 15 นาที กันค้าง

    const { commandName } = interaction;
    const isDM = !interaction.guild;
    const historyKey = isDM ? `dm-${interaction.user.id}` : `ch-${interaction.channelId}`;

    // ---- /help ----
    if (commandName === "help") {
      return interaction.editReply(`📚 **คำสั่งทั้งหมด**

🤖 \`/ask <คำถาม> [ไฟล์]\` — ถาม Skibidri AI (แนบรูป/PDF/ไฟล์ข้อความได้)
🎨 \`/image <คำอธิบาย>\` — สร้างรูปภาพ
📄 \`/pdf <คำสั่ง>\` — ให้ AI เขียนแล้วส่งเป็นไฟล์ PDF
🗑️ \`/clear\` — ล้างประวัติสนทนา
⚙️ \`/panel\` — ตั้งค่า Prompt ของ AI (Admin)
🎙️ \`/join\` — เข้าช่องเสียง + คุยกับ Gemini Live
👋 \`/leave\` — ออกจากช่องเสียง
❓ \`/help\` — แสดงคำสั่งทั้งหมด

หรือจะ **mention บอท** / **DM** ตรงๆ ก็คุยได้เลยครับ!`);
    }

    // ---- /clear ----
    if (commandName === "clear") {
      clearHistory(historyKey);
      return interaction.editReply("🗑️ ล้างประวัติสนทนาแล้วครับ!");
    }

    // ---- /panel ----
    if (commandName === "panel") {
      if (!interaction.guild) return interaction.editReply("❌ คำสั่งนี้ใช้ได้เฉพาะใน server ครับ");
      return interaction.editReply(buildPanel(interaction.guild.id));
    }

    // ---- /pdf ----
    if (commandName === "pdf") {
      const prompt = interaction.options.getString("prompt");
      const fontChoice = interaction.options.getString("font"); // "sarabun" | "itim" | "kanit" | null
      try {
        const fontSource = fontChoice ? FONT_MAP[fontChoice] : null; // null → textToPDF ใช้ DEFAULT_FONT (Sarabun) เอง
        const content = await askAI(prompt, historyKey, interaction.guild?.id, []);
        const pdfBuffer = await textToPDF(content, "Skibidri", fontSource);
        return interaction.editReply({ content: "📄 นี่ไฟล์ PDF ครับ", files: [pdfToFile(pdfBuffer)] });
      } catch (err) {
        console.error("PDF generation error:", err);
        return interaction.editReply(`❌ สร้าง PDF ไม่ได้: ${err.message}`);
      }
    }

    // ---- /image ----
    if (commandName === "image") {
      const prompt = interaction.options.getString("prompt");
      try {
        // 1. ส่ง request สร้างรูป
        const createRes = await axios.post(
          "https://api.bfl.ai/v1/flux-pro-1.1",
          { prompt, width: 1024, height: 1024 },
          { headers: { "x-key": process.env.BFL_API_KEY, "Content-Type": "application/json" } }
        );
        const { id: taskId, polling_url: pollingUrl } = createRes.data;
        if (!taskId || !pollingUrl) return interaction.editReply("❌ สร้างรูปไม่สำเร็จ ลองใหม่ครับ");

        // 2. รอ poll จนรูปพร้อม (timeout ~60s) — ใช้ polling_url ที่ได้มาตรงๆ ห้ามสร้าง URL เอง
        let imageUrl = null;
        let failReason = null;
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const pollRes = await axios.get(pollingUrl, {
            headers: { "x-key": process.env.BFL_API_KEY }
          });
          const status = pollRes.data.status;
          if (status === "Ready") { imageUrl = pollRes.data.result?.sample; break; }
          if (["Error", "Failed", "Request Moderated", "Content Moderated"].includes(status)) {
            failReason = status;
            break;
          }
        }
        if (failReason === "Request Moderated" || failReason === "Content Moderated") {
          return interaction.editReply("🚫 prompt นี้โดน moderate ครับ ลองเปลี่ยนคำอธิบายใหม่");
        }
        if (failReason) return interaction.editReply(`❌ สร้างรูปไม่สำเร็จ (${failReason})`);
        if (!imageUrl) return interaction.editReply("❌ สร้างรูปนานเกินไป ลองใหม่ครับ");

        // 3. ดาวน์โหลดและส่งรูป
        const imgRes = await axios.get(imageUrl, { responseType: "arraybuffer" });
        const attachment = new AttachmentBuilder(Buffer.from(imgRes.data), { name: "image.png" });
        return interaction.editReply({ content: `🎨 **${prompt}**`, files: [attachment] });
      } catch (err) {
        console.error("Flux API error:", err?.response?.data || err.message);
        return interaction.editReply("❌ สร้างรูปไม่สำเร็จ ลองใหม่ครับ");
      }
    }

    // ---- /join ----
    if (commandName === "join") {
      if (!interaction.guild) return interaction.editReply("❌ คำสั่งนี้ใช้ได้เฉพาะใน server ครับ");
      const vc = interaction.member?.voice?.channel;
      if (!vc) return interaction.editReply("❌ เข้าช่องเสียงก่อนนะครับ!");
      if (voiceSessions.has(interaction.guild.id)) return interaction.editReply("❌ บอทอยู่ในช่องเสียงแล้วครับ!");
      await interaction.editReply("⏳ กำลังเชื่อมต่อ Gemini Live...");
      await startVoiceSession(interaction, vc);
      return;
    }

    // ---- /leave ----
    if (commandName === "leave") {
      const s = voiceSessions.get(interaction.guild?.id);
      if (!s) return interaction.editReply("❌ บอทไม่ได้อยู่ในช่องเสียงครับ!");
      voiceSessions.delete(interaction.guild.id); // ลบก่อน close กัน onclose สั่ง reconnect
      try { s.liveSession?.close(); } catch {}
      s.connection.destroy();
      return interaction.editReply("👋 ออกจากช่องเสียงแล้วครับ");
    }

    // ---- /ask ----
    if (commandName === "ask") {
      const userMessage = interaction.options.getString("question");
      const file = interaction.options.getAttachment("file");
      try {
        const replyText = await askAI(userMessage, historyKey, interaction.guild?.id, file ? [file] : []);
        if (replyText.length <= 2000) {
          await interaction.editReply(replyText);
        } else {
          await interaction.editReply({ content: "📄 คำตอบยาวเกิน ส่งเป็นไฟล์ให้ครับ", files: [textToFile(replyText)] });
        }
      } catch (error) {
        console.error("Error:", error);
        await interaction.editReply("❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งครับ");
      }
      return;
    }

    return;
  }

  // ── Buttons / Modal (Prompt Panel) — ใช้ได้เฉพาะใน server ──────────────────
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

// ─── Messages (mention / DM → คุยกับ AI ตรงๆ) ───────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user);
  const isDM = !message.guild;
  if (!isMentioned && !isDM) return;

  const content = message.content.trim();
  const historyKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;
  const userMessage = content.replace(/<@!?\d+>/g, "").trim();
  const attachments = [...message.attachments.values()];

  if (!userMessage && attachments.length === 0) return message.reply("สวัสดีครับ! ใช้ `/help` เพื่อดูคำสั่งทั้งหมดได้เลยครับ 😊");

  try {
    await message.channel.sendTyping();
    const replyText = await askAI(userMessage, historyKey, message.guild?.id, attachments);

    if (replyText.length <= 2000) {
      await message.reply(replyText);
    } else {
      await message.reply({ content: "📄 คำตอบยาวเกิน ส่งเป็นไฟล์ให้ครับ", files: [textToFile(replyText)] });
    }
  } catch (error) {
    console.error("Error:", error);
    await message.reply("❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งครับ");
  }
});

if (!process.env.DISCORD_TOKEN || !process.env.GEMINI_API_KEY || !process.env.CLIENT_ID) {
  console.error("❌ กรุณาตั้งค่า DISCORD_TOKEN, GEMINI_API_KEY และ CLIENT_ID!");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
