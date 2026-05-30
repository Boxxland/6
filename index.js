const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");
const fs = require("fs");

// ---- JSON Database ----
const DB_FILE = "history.json";

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}");
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch { return {}; }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data));
}

function getHistory(key) {
  return loadDB()[key] || [];
}

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

// ---- Gemma 4 Setup ----
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM = `คุณคือ Skibidri AI เพื่อการศึกษา ในเซิร์ฟเวอร์ Discord
อธิบายเนื้อหาวิชาการได้ทุกระดับ ตั้งแต่ประถมถึงมหาวิทยาลัย
ใช้ภาษาเข้าใจง่าย ยกตัวอย่างประกอบเสมอ รองรับทั้งภาษาไทยและอังกฤษ
ถ้าตอบยาวแบ่งเป็นข้อๆ ถ้าถามว่าคุณคือใคร ให้บอกว่าคือ Skibidri`;

// ---- Discord ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once("ready", () => {
  console.log(`✅ บอทออนไลน์แล้ว! เข้าสู่ระบบในชื่อ ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user);
  const isDM = message.channel.type === 1;
  const content = message.content.trim();
  const historyKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;

  if (content === "!help") {
    return message.reply(`📚 **คำสั่งทั้งหมด**\n\n🤖 \`!ask <คำถาม>\` — ถาม Skibidri AI\n🎨 \`!image <คำอธิบาย>\` — สร้างรูปภาพ\n🗑️ \`!clear\` — ล้างประวัติสนทนา\n❓ \`!help\` — แสดงคำสั่ง\n\nหรือ **mention** / **DM** ตรงๆ ได้เลยครับ!`);
  }

  if (content === "!clear") {
    clearHistory(historyKey);
    return message.reply("🗑️ ล้างประวัติสนทนาแล้วครับ!");
  }

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
      return message.reply("❌ สร้างรูปไม่สำเร็จ ลองใหม่ครับ");
    }
  }

  let userMessage = "";
  if (content.startsWith("!ask ")) {
    userMessage = content.slice(5).trim();
  } else if (isMentioned || isDM) {
    userMessage = content.replace(/<@!?\d+>/g, "").trim();
  } else {
    return;
  }

  if (!userMessage) return message.reply("สวัสดีครับ! พิมพ์ `!help` เพื่อดูคำสั่งได้เลยครับ 😊");

  try {
    await message.channel.sendTyping();

    const history = getHistory(historyKey);
    const chat = ai.chats.create({
      model: "gemma-4-31b-it",
      config: { systemInstruction: SYSTEM },
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
    await message.reply("❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะครับ");
  }
});

client.login(process.env.DISCORD_TOKEN);
