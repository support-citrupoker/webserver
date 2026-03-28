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
   * Send a text iMessage - Method 1: Using phone number/email
   */
  async sendMessage({ to, from, message, effectId, chatGuid }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   From: ${from}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      let response;
      
      // Method 1: If we have a chat GUID, send directly to that chat
      if (chatGuid) {
        console.log(`   Using chat GUID: ${chatGuid}`);
        const payload = { text: message };
        if (effectId) payload.effectId = effectId;
        
        response = await this.client.post(
          `/api/v1/chat/${chatGuid}/message?password=${encodeURIComponent(this.password)}`,
          payload
        );
      } 
      // Method 2: Send to phone number/email
      else if (to) {
        console.log(`   Sending to phone/email: ${to}`);
        const payload = { 
          text: message,
          to: to
        };
        
        // Add from if provided (your iMessage account)
        if (from) {
          payload.from = from;
        }
        
        if (effectId) payload.effectId = effectId;
        
        response = await this.client.post(
          `/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
          payload
        );
      }
      else {
        throw new Error('Either chatGuid or to parameter is required');
      }
      
      console.log(`✅ iMessage sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      console.error(`   Status: ${error.response?.status}`);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Alternative: Send to a specific chat GUID (more reliable)
   */
  async sendToChat({ chatGuid, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage to chat: ${chatGuid}`);
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
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Get chat GUID for a phone number/email
   */
  async getChatGuid(address) {
    try {
      console.log(`🔍 Looking up chat GUID for: ${address}`);
      
      const response = await this.client.get(
        `/api/v1/chats?password=${encodeURIComponent(this.password)}`
      );
      
      const chats = response.data;
      
      // Find chat by phone number or email
      const chat = chats.find(c => 
        c.displayName === address || 
        c.participants?.some(p => p.address === address)
      );
      
      if (chat) {
        console.log(`   Found chat GUID: ${chat.guid}`);
        return chat.guid;
      }
      
      console.log(`   No existing chat found for ${address}`);
      return null;
    } catch (error) {
      console.error('Failed to get chat GUID:', error.message);
      return null;
    }
  }

  async sendAttachment({ to, from, message, mediaUrl, effectId, chatGuid }) {
    try {
      console.log(`📸 Sending iMessage with attachment:`);
      console.log(`   To: ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      let response;
      
      if (chatGuid) {
        const payload = { 
          text: message || '', 
          attachment: mediaUrl 
        };
        if (effectId) payload.effectId = effectId;
        
        response = await this.client.post(
          `/api/v1/chat/${chatGuid}/attachment?password=${encodeURIComponent(this.password)}`,
          payload
        );
      } else {
        const payload = { 
          to: to,
          text: message || '', 
          attachment: mediaUrl 
        };
        if (from) payload.from = from;
        if (effectId) payload.effectId = effectId;
        
        response = await this.client.post(
          `/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`,
          payload
        );
      }
      
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
      console.error('BlueBubbles status error:', error.response?.data || error.message);
      return {
        connected: false,
        serverUrl: this.serverUrl,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async getChats(limit = 20) {
    try {
      const response = await this.client.get(`/api/v1/chats?password=${encodeURIComponent(this.password)}`, { 
        params: { limit } 
      });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch chats:', error.message);
      throw error;
    }
  }

  async checkiMessageAvailability(address) {
    try {
      const cleanAddress = address.trim();
      const response = await this.client.get(`/api/v1/handle/availability/imessage?password=${encodeURIComponent(this.password)}`, {
        params: { address: cleanAddress }
      });
      
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