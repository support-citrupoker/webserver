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
   * Find an existing chat by phone number or email
   */
  async findChatByAddress(address) {
    try {
      console.log(`🔍 Finding chat for: ${address}`);
      
      const response = await this.client.get(`/api/v1/chats?password=${encodeURIComponent(this.password)}`);
      const chats = response.data;
      
      if (chats && Array.isArray(chats)) {
        const chat = chats.find(c => {
          // Check by display name
          if (c.displayName === address) return true;
          // Check participants
          if (c.participants && Array.isArray(c.participants)) {
            return c.participants.some(p => p.address === address);
          }
          return false;
        });
        
        if (chat) {
          console.log(`   ✅ Found chat GUID: ${chat.guid}`);
          return chat.guid;
        }
      }
      
      console.log(`   ⚠️ No existing chat found for ${address}`);
      return null;
    } catch (error) {
      console.error('Failed to find chat:', error.message);
      return null;
    }
  }

  /**
   * Get all chats (useful for debugging)
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
   * Send a message to a specific chat GUID (most reliable method)
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
        chatGuid: chatGuid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send a message - automatically finds or creates chat
   */
  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      // First, try to find existing chat
      let chatGuid = await this.findChatByAddress(to);
      
      let response;
      
      if (chatGuid) {
        // Use existing chat
        console.log(`   Using existing chat: ${chatGuid}`);
        response = await this.sendToChat({ chatGuid, message, effectId });
      } else {
        // No existing chat found - try the message/text endpoint (this should create a new chat)
        console.log(`   No existing chat, using message/text endpoint to create new chat...`);
        
        const payload = { 
          text: message,
          to: to
        };
        if (from) payload.from = from;
        if (effectId) payload.effectId = effectId;
        
        response = await this.client.post(
          `/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
          payload
        );
        
        console.log(`✅ New chat created and message sent! GUID: ${response.data.guid}`);
        response = {
          success: true,
          guid: response.data.guid,
          chatGuid: response.data.chatGuid,
          timestamp: response.data.timestamp
        };
      }
      
      return response;
      
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send an attachment
   */
  async sendAttachment({ to, from, message, mediaUrl, effectId }) {
    try {
      console.log(`📸 Sending iMessage with attachment:`);
      console.log(`   To: ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      // First, try to find existing chat
      let chatGuid = await this.findChatByAddress(to);
      
      if (chatGuid) {
        // Send attachment to existing chat
        const payload = { 
          text: message || '', 
          attachment: mediaUrl 
        };
        if (effectId) payload.effectId = effectId;
        
        const response = await this.client.post(
          `/api/v1/chat/${chatGuid}/attachment?password=${encodeURIComponent(this.password)}`,
          payload
        );
        
        console.log(`✅ iMessage with attachment sent! GUID: ${response.data.guid}`);
        return {
          success: true,
          guid: response.data.guid,
          chatGuid: chatGuid,
          timestamp: response.data.timestamp
        };
      } else {
        // Use the attachment endpoint which should create a new chat
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
        
        console.log(`✅ New chat created and attachment sent! GUID: ${response.data.guid}`);
        return {
          success: true,
          guid: response.data.guid,
          chatGuid: response.data.chatGuid,
          timestamp: response.data.timestamp
        };
      }
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