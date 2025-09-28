const axios = require('axios');
const { randomUUID } = require('crypto');
const { sendMessage } = require('../handles/sendMessage');

// Configuration - Easy to replace
const CONFIG = {
  API_URL: 'https://mangaquest-10021969.chipp.ai/api/chat',
  ORIGIN: 'https://mangaquest-10021969.chipp.ai',
  REFERER: 'https://mangaquest-10021969.chipp.ai/w/chat/MangaQuest-10021969/session/b069f5e8-640c-4a93-ae8d-365b39d1faa3',
  COOKIE: '__Host-next-auth.csrf-token=4723c7d0081a66dd0b572f5e85f5b40c2543881365782b6dcca3ef7eabdc33d6%7C06adf96c05173095abb983f9138b5e7ee281721e3935222c8b369c71c8e6536b; __Secure-next-auth.callback-url=https%3A%2F%2Fapp.chipp.ai; userId_70381=729a0bf6-bf9f-4ded-a861-9fbb75b839f5; correlationId=f8752bd2-a7b2-47ff-bd33-d30e5480eea8'
};

// Module metadata
const MODULE_INFO = {
  name: 'ai',
  description: 'Quickly find and share the latest chapters of any manga, manhwa, or manhua with direct, safe reading links.',
  usage: ' [your message]',
  author: 'coffee'
};

// Bold formatting for text wrapped in asterisks (*text*)
const formatBold = text => text.replace(/\*(.+?)\*/g, (_, word) =>
  [...word].map(char => {
    const code = char.codePointAt(0);
    return String.fromCodePoint(
      code >= 97 && code <= 122 ? code + 0x1D41A - 97 :  // a-z
      code >= 65 && code <= 90 ? code + 0x1D400 - 65 :   // A-Z
      code >= 48 && code <= 57 ? code + 0x1D7CE - 48 :   // 0-9
      code
    );
  }).join('')
);

// Efficient image URL fetcher with error handling
const getImageUrl = async (event, token, cache) => {
  const { sender: { id: senderId }, message } = event;
  const cached = cache?.get(senderId);

  // Return cached image if valid (5min TTL)
  if (cached && Date.now() - cached.timestamp < 300_000) {
    console.log(`✅ Using cached image for ${senderId}`);
    return cached.url;
  }

  const mid = message?.reply_to?.mid ?? message?.mid;
  if (!mid) return null;

  try {
    const { data } = await axios.get(`https://graph.facebook.com/v23.0/${mid}/attachments`, {
      params: { access_token: token },
      timeout: 5000
    });

    return data?.data?.[0]?.image_data?.url ?? data?.data?.[0]?.file_url ?? null;
  } catch (error) {
    console.warn("⚠️ Image fetch error:", error?.response?.data ?? error.message);
    return null;
  }
};

// Optimized message chunking
const chunkMessage = (text, maxSize = 1900) => 
  Array.from({ length: Math.ceil(text.length / maxSize) }, (_, i) => 
    text.slice(i * maxSize, (i + 1) * maxSize)
  );

// Conversation history with Map for better performance
const conversationHistory = new Map();
const MAX_HISTORY = 20;
const KEEP_RECENT = 12;

// Reusable headers object - now uses CONFIG values
const API_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'origin': CONFIG.ORIGIN,
  'referer': CONFIG.REFERER,
  'cookie': CONFIG.COOKIE
});

// Response parsing with modern regex and nullish coalescing
const parseResponse = (data) => {
  const textData = typeof data === 'string' ? data : JSON.stringify(data);
  const patterns = [/"result":"([^"]*)"/g, /0:"([^"]*)"/g];

  for (const pattern of patterns) {
    const matches = [...textData.matchAll(pattern)];
    if (matches.length > 0) {
      return matches.map(match => match[1].replace(/\\n/g, '\n')).join('');
    }
  }
  return '';
};

// Handle tool calls with modern destructuring
const handleToolCalls = async (toolCalls, senderId, pageAccessToken, sendMessage) => {
  for (const { toolName, state, result } of toolCalls) {
    if (state !== 'result' || !result) continue;

    switch (toolName) {
      case 'generateImage':
        await sendMessage(senderId, { text: `🖼️ Generated Image:\n${result}` }, pageAccessToken);
        return { handled: true };

      case 'browseWeb':
        const snippets = result.answerBox?.answer ?? 
          result.organic?.map(o => o.snippet).filter(Boolean).join('\n\n') ?? 
          'No relevant info found.';
        return { additionalText: `\n\n🌐 Browse result:\n${snippets}` };
    }
  }
  return { handled: false };
};

// Handle image responses
const handleImageResponse = async (text, senderId, pageAccessToken, sendMessage) => {
  const imageMatch = text.match(/https:\/\/storage\.googleapis\.com\/chipp-images\/[^\s")]+/);
  if (imageMatch) {
    const cleanUrl = imageMatch[0].replace(/[)]+$/, '');
    await sendMessage(senderId, {
      attachment: {
        type: 'image',
        payload: { url: cleanUrl, is_reusable: true }
      }
    }, pageAccessToken);
    return true;
  }
  return false;
};

module.exports = {
  ...MODULE_INFO,

  async execute(senderId, args, pageAccessToken, event, sendMessage, imageCache) {
    const rawPrompt = args.join(' ').trim() || 'Hello';
    const chatSessionId = randomUUID(); // Native crypto UUID generation

    try {
      // Parallel image URL fetching
      const [imageUrl] = await Promise.allSettled([
        getImageUrl(event, pageAccessToken, imageCache)
      ]);

      const prompt = imageUrl.value ? `${rawPrompt}\n\nImage URL: ${imageUrl.value}` : rawPrompt;

      // Manage conversation history
      if (!conversationHistory.has(senderId)) {
        conversationHistory.set(senderId, []);
      }

      const userHistory = conversationHistory.get(senderId);
      if (userHistory.length > MAX_HISTORY) {
        conversationHistory.set(senderId, userHistory.slice(-KEEP_RECENT));
      }

      userHistory.push({ role: 'user', content: prompt });

      // API call with timeout and proper error handling - now uses CONFIG.API_URL
      const { data } = await axios.post(
        CONFIG.API_URL,
        { chatSessionId, messages: userHistory },
        { headers: API_HEADERS, timeout: 30_000 }
      );

      let fullResponseText = parseResponse(data);
      const toolCalls = data.choices?.[0]?.message?.toolInvocations ?? [];

      // Handle tool calls
      const toolResult = await handleToolCalls(toolCalls, senderId, pageAccessToken, sendMessage);
      if (toolResult.handled) return;
      if (toolResult.additionalText) fullResponseText += toolResult.additionalText;

      // Update conversation history if we have a response
      if (fullResponseText) {
        userHistory.push({ role: 'assistant', content: fullResponseText });
      }

      // Handle image responses
      if (await handleImageResponse(fullResponseText, senderId, pageAccessToken, sendMessage)) {
        return;
      }

      if (!fullResponseText) {
        throw new Error('Empty response from AI service');
      }

      // Send formatted response
      const formatted = `💬 | 𝙼𝚊𝚗𝚐𝚊𝚂𝚎𝚊𝚛𝚌𝚑\n・───────────・\n${formatBold(fullResponseText)}\n・──── >ᴗ< ────・`;

      // Send all chunks concurrently for better performance
      const chunks = chunkMessage(formatted);
      await Promise.allSettled(
        chunks.map((chunk, index) => 
          // Add small delay between chunks to maintain order
          new Promise(resolve => 
            setTimeout(() => resolve(sendMessage(senderId, { text: chunk }, pageAccessToken)), index * 100)
          )
        )
      );

    } catch (error) {
      console.error('AI Command Error:', {
        message: error.message,
        response: error?.response?.data,
        stack: error.stack
      });

      await sendMessage(senderId, { 
        text: '❎ | An error occurred. Please try again later.' 
      }, pageAccessToken);
    }
  }
};