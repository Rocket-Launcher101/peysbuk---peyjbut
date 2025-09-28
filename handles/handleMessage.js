const fs = require('fs');
const path = require('path');
const { sendMessage } = require('./sendMessage');

// Command registry and caches
const commands = new Map();
const imageCache = new Map(); // Keep existing for backward compatibility
const mediaCache = new Map(); // New cache for all media types
const prefixes = ['-', '/']; // Multiple prefixes supported
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Load commands on startup
const loadCommands = () => {
  const commandsDir = path.join(__dirname, '../commands');

  for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
    delete require.cache[require.resolve(`../commands/${file}`)]; // Hot reload
    const command = require(`../commands/${file}`);

    const names = Array.isArray(command.name) ? command.name : [command.name];
    names.forEach(name => {
      if (typeof name === 'string') {
        commands.set(name.toLowerCase(), command);
      }
    });
  }
};

loadCommands();

// Clean expired cache entries
setInterval(() => {
  const now = Date.now();
  
  // Clean imageCache
  for (const [key, value] of imageCache) {
    if (now - value.timestamp > CACHE_TTL) {
      imageCache.delete(key);
    }
  }
  
  // Clean mediaCache
  for (const [key, value] of mediaCache) {
    if (now - value.timestamp > CACHE_TTL) {
      mediaCache.delete(key);
    }
  }
}, CACHE_TTL);

const handleMessage = async (event, pageAccessToken) => {
  const senderId = event?.sender?.id;
  if (!senderId) return;

  const messageText = event?.message?.text?.trim();
  const attachments = event?.message?.attachments || [];

  // Cache attachments
  for (const attachment of attachments) {
    if (attachment.type === 'image' && attachment.payload?.url) {
      // Keep existing imageCache for backward compatibility
      imageCache.set(senderId, {
        url: attachment.payload.url,
        timestamp: Date.now()
      });
      
      // Also add to mediaCache
      mediaCache.set(senderId, {
        url: attachment.payload.url,
        type: 'image',
        timestamp: Date.now()
      });
    } else if (attachment.type === 'video' && attachment.payload?.url) {
      // Add video to mediaCache
      mediaCache.set(senderId, {
        url: attachment.payload.url,
        type: 'video',
        timestamp: Date.now()
      });
    } else if (attachment.type === 'audio' && attachment.payload?.url) {
      // Add audio to mediaCache
      mediaCache.set(senderId, {
        url: attachment.payload.url,
        type: 'audio',
        timestamp: Date.now()
      });
    } else if (attachment.type === 'file' && attachment.payload?.url) {
      // Add generic files to mediaCache
      mediaCache.set(senderId, {
        url: attachment.payload.url,
        type: 'file',
        timestamp: Date.now()
      });
    }
  }

  if (!messageText) return;

  // Check if message starts with any of the prefixes
  const usedPrefix = prefixes.find(prefix => messageText.startsWith(prefix));
  const isCommand = !!usedPrefix;

  const [commandName, ...args] = isCommand 
    ? messageText.slice(usedPrefix.length).split(' ')
    : messageText.split(' ');

  const normalizedCommand = commandName.toLowerCase();

  try {
    const command = commands.get(normalizedCommand);

    if (command) {
      // Pass both caches - commands can use whichever they need
      if (command.name === 'getlink') {
        // getlink command gets mediaCache
        await command.execute(senderId, args, pageAccessToken, event, sendMessage, mediaCache);
      } else {
        // Other commands get imageCache for backward compatibility
        await command.execute(senderId, args, pageAccessToken, event, sendMessage, imageCache);
      }
    } else if (commands.has('ai')) {
      // Fallback to AI with full message text
      await commands.get('ai').execute(senderId, [messageText], pageAccessToken, event, sendMessage, imageCache);
    } else {
      await sendMessage(senderId, { text: 'Unknown command. Type "help" for available commands.' }, pageAccessToken);
    }
  } catch (error) {
    console.error('Command execution error:', error.message);
    await sendMessage(senderId, { text: '❌ Command execution failed.' }, pageAccessToken);
  }
};

module.exports = { handleMessage };