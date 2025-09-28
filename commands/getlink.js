const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Catbox } = require('node-catbox');
const { sendMessage } = require('../handles/sendMessage');

const catbox = new Catbox();

const getAttachmentUrl = async (event, token) => {
  const mid = event?.message?.reply_to?.mid || event?.message?.mid;
  if (!mid) return null;

  try {
    const { data } = await axios.get(`https://graph.facebook.com/v23.0/${mid}/attachments`, {
      params: { access_token: token }
    });

    const attachment = data?.data?.[0];
    if (!attachment) return null;

    // Handle different attachment types
    let mediaUrl = null;
    let mediaType = 'unknown';

    if (attachment.image_data) {
      mediaUrl = attachment.image_data.url;
      mediaType = 'image';
    } else if (attachment.video_data) {
      mediaUrl = attachment.video_data.url;
      mediaType = 'video';
    } else if (attachment.audio_data) {
      mediaUrl = attachment.audio_data.url;
      mediaType = 'audio';
    } else if (attachment.file_url) {
      mediaUrl = attachment.file_url;
      mediaType = 'file';
    }

    return { url: mediaUrl, type: mediaType };
  } catch (err) {
    console.error("Attachment URL fetch error:", err?.response?.data || err.message);
    return null;
  }
};

module.exports = {
  name: 'getlink',
  description: 'Upload image, video, or audio to Catbox and get permanent link.',
  usage: '-getlink (reply to an image, video, or audio file)',
  author: 'coffee',

  execute: async (senderId, args, pageAccessToken, event, sendMessage, mediaCache) => {
    // First try reply_to mid (normal behavior)
    let attachment = await getAttachmentUrl(event, pageAccessToken);

    // If no reply attachment found, fallback to cached media
    if (!attachment && mediaCache) {
      const cachedMedia = mediaCache.get(senderId);
      if (cachedMedia && Date.now() - cachedMedia.timestamp <= 5 * 60 * 1000) { // 5 min expiry
        attachment = { url: cachedMedia.url, type: cachedMedia.type || 'image' };
        console.log(`Using cached ${attachment.type} for sender ${senderId}: ${attachment.url}`);
      }
    }

    if (!attachment || !attachment.url) {
      return sendMessage(senderId, { text: '❎ | Please reply to an image, video, or audio file, then run this command.' }, pageAccessToken);
    }

    const { url: mediaUrl, type: mediaType } = attachment;
    
    // Get file extension based on type
    const getFileExtension = (type, url) => {
      if (type === 'image') return 'jpg';
      if (type === 'video') return 'mp4';
      if (type === 'audio') return 'mp3';
      // Try to extract from URL
      const match = url.match(/\.([^.?]+)(?:\?|$)/);
      return match ? match[1] : 'bin';
    };

    const fileExt = getFileExtension(mediaType, mediaUrl);
    const tmpInput = path.join(__dirname, `tmp_getlink_${Date.now()}.${fileExt}`);

    try {
      // Send processing message with media type info
      const typeEmoji = mediaType === 'image' ? '🖼️' : mediaType === 'video' ? '🎥' : mediaType === 'audio' ? '🎵' : '📁';
      await sendMessage(senderId, { text: `⏳ | Uploading ${mediaType} to Catbox... ${typeEmoji}` }, pageAccessToken);

      // Download media from Facebook
      const mediaResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      fs.writeFileSync(tmpInput, mediaResponse.data);

      // Upload to Catbox
      const catboxUrl = await catbox.uploadFile({
        path: tmpInput
      });

      if (!catboxUrl) {
        return sendMessage(senderId, { text: `❎ | Failed to upload ${mediaType} to Catbox. Please try again.` }, pageAccessToken);
      }

      // Send success message with the link and media type info
      await sendMessage(senderId, { 
        text: `✅ | ${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} uploaded successfully! ${typeEmoji}\n\n🔗 Link: ${catboxUrl}\n\n📋 The link is permanent and ready to share!` 
      }, pageAccessToken);

    } catch (err) {
      console.error('GetLink Error:', err?.response?.data || err.message || err);
      return sendMessage(senderId, { text: `❎ | Failed to upload ${mediaType}. Please try again later.` }, pageAccessToken);
    } finally {
      // Clean up temporary file
      try { 
        if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput); 
      } catch (cleanupErr) {
        console.error('Cleanup error:', cleanupErr);
      }
    }
  }
};