// services/bluebubblesService.js
import axios from 'axios';

class BlueBubblesService {
  constructor(serverUrl, password) {
    this.serverUrl = serverUrl;
    this.password = password;
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Server URL: ${serverUrl}`);
    console.log(`   Password: ${password ? '***' + password.slice(-4) : 'MISSING'}`);
    
    this.client = axios.create({
      baseURL: serverUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  /**
   * Send a text iMessage - This creates a chat automatically if it doesn't exist
   */
  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   From: ${from || 'auto'}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      const payload = { 
        text: message,
        to: to  // The API accepts 'to' field directly
      };
      
      // Add optional fields
      if (from) payload.from = from;
      if (effectId) payload.effectId = effectId;
      
      // Send via the message/text endpoint (creates chat automatically)
      const response = await this.client.post(
        `/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
        payload
      );
      
      console.log(`✅ iMessage sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        chatGuid: response.data.chatGuid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send a message to an existing chat by GUID (more reliable)
   */
  async sendToChat({ chatGuid, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage to existing chat: ${chatGuid}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      const payload = { text: message };
      if (effectId) payload.effectId = effectId;
      
      const response = await this.client.post(
        `/api/v1/chat/${chatGuid}/message?password=${encodeURIComponent(this.password)}`,
        payload
      );
      
      console.log(`✅ iMessage sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        chatGuid: chatGuid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Get existing chats to find a chat GUID
   */
  async getChats(limit = 50) {
    try {
      const response = await this.client.get(
        `/api/v1/chats?password=${encodeURIComponent(this.password)}`,
        { params: { limit } }
      );
      return response.data;
    } catch (error) {
      console.error('Failed to fetch chats:', error.message);
      throw error;
    }
  }

  /**
   * Find chat GUID for a phone number
   */
  async findChatByPhone(phoneNumber) {
    try {
      const chats = await this.getChats(100);
      const chat = chats.find(c => 
        c.displayName === phoneNumber || 
        c.participants?.some(p => p.address === phoneNumber)
      );
      return chat?.guid || null;
    } catch (error) {
      console.error('Failed to find chat:', error.message);
      return null;
    }
  }

  async sendAttachment({ to, from, message, mediaUrl, effectId }) {
    try {
      console.log(`📸 Sending iMessage with attachment:`);
      console.log(`   To: ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      const payload = { 
        to: to,
        text: message || '', 
        attachment: mediaUrl
      };
      if (from) payload.from = from;
      if (effectId) payload.effectId = effectId;
      
      const response = await this.client.post(
        `/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`,
        payload
      );
      
      console.log(`✅ iMessage with attachment sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles attachment error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage with attachment: ${error.message}`);
    }
  }

  async getStatus() {
    try {
      const response = await this.client.get(`/api/v1/ping?password=${encodeURIComponent(this.password)}`);
      return {
        connected: true,
        serverUrl: this.serverUrl,
        version: response.data?.version || 'unknown',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        connected: false,
        serverUrl: this.serverUrl,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async checkiMessageAvailability(address) {
    try {
      const cleanAddress = address.trim();
      const response = await this.client.get(
        `/api/v1/handle/availability/imessage?password=${encodeURIComponent(this.password)}`,
        { params: { address: cleanAddress } }
      );
      
      return {
        hasiMessage: response.data.available === true,
        service: response.data.service || (response.data.available ? 'iMessage' : 'SMS'),
        address: cleanAddress,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('iMessage availability check failed:', error.message);
      return {
        hasiMessage: false,
        service: 'SMS',
        address: address,
        error: error.message
      };
    }
  }
}

export default BlueBubblesService;