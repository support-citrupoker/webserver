// services/bluebubbles.service.js - ORIGINAL WORKING VERSION
import axios from 'axios';

class BlueBubblesService {
  constructor() {
    this.serverUrl = process.env.BLUEBUBBLES_SERVER_URL || 'http://localhost:3030';
    this.password = process.env.BLUEBUBBLES_PASSWORD;
    this.imessageAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT;
    
    if (!this.password) {
      console.error('❌ BLUEBUBBLES_PASSWORD not set');
    }
    
    this.client = axios.create({
      baseURL: `${this.serverUrl}/api/v1`,
      headers: {
        'Authorization': `Bearer ${this.password}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Server URL: ${this.serverUrl}`);
    console.log(`   Password: ${this.password ? '***' : 'Not set'}`);
  }

  async sendMessage({ to, from, message, effectId = null }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message}`);
      
      // Simple chat GUID format that worked before
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        const cleanNumber = to.replace(/\D/g, '');
        chatGuid = `+${cleanNumber}`;
      }
      
      console.log(`   Chat GUID: ${chatGuid}`);
      
      const payload = {
        chatGuid: chatGuid,
        message: message,
        method: 'appleScript'
      };
      
      if (effectId) payload.effectId = effectId;
      if (from) payload.from = from;
      
      console.log(`   Payload:`, JSON.stringify(payload, null, 2));
      
      const response = await this.client.post('/message/send', payload);
      
      console.log(`   ✅ iMessage sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        messageId: response.data.guid
      };
      
    } catch (error) {
      console.error(`   ❌ BlueBubbles send error:`, error.response?.data || error.message);
      
      // Check if it's an AppleScript error
      if (error.response?.data?.error?.message?.includes('AppleScript')) {
        console.error(`   ⚠️ AppleScript error - check your Mac's Messages app permissions`);
        console.error(`   Make sure Messages app is open and signed in`);
        console.error(`   Also check BlueBubbles permissions in System Settings → Privacy & Security → Automation`);
      }
      
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  async sendAttachment({ to, from, message, mediaUrl, effectId = null }) {
    try {
      console.log(`📸 Sending attachment via BlueBubbles to ${to}`);
      
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        const cleanNumber = to.replace(/\D/g, '');
        chatGuid = `+${cleanNumber}`;
      }
      
      const payload = {
        chatGuid: chatGuid,
        message: message || '📎 Attachment',
        method: 'appleScript',
        file: mediaUrl
      };
      
      if (effectId) payload.effectId = effectId;
      if (from) payload.from = from;
      
      const response = await this.client.post('/message/send', payload);
      
      return {
        success: true,
        guid: response.data.guid,
        messageId: response.data.guid
      };
      
    } catch (error) {
      console.error(`   ❌ Failed to send attachment:`, error.message);
      throw error;
    }
  }

  async getStatus() {
    try {
      const response = await this.client.get('/ping');
      return response.data;
    } catch (error) {
      console.error('Failed to get status:', error.message);
      return { status: 'error', message: error.message };
    }
  }

  async getChats(limit = 20) {
    try {
      const response = await this.client.get(`/chats?limit=${limit}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get chats:', error.message);
      return [];
    }
  }

  async sendTypingIndicator(chatGuid, isTyping = true) {
    try {
      const response = await this.client.post('/typing', {
        chatGuid: chatGuid,
        isTyping: isTyping
      });
      return response.data;
    } catch (error) {
      console.error('Failed to send typing indicator:', error.message);
      return null;
    }
  }
}

export default BlueBubblesService;