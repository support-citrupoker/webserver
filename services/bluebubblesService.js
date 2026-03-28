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
   * Create a chat with a phone number/email
   * This is the key method - we need a chat GUID before sending messages
   */
  async createChat(address) {
    try {
      console.log(`📝 Creating new chat for: ${address}`);
      
      // According to IMCore docs, we need to create a chat first
      // The endpoint might be /api/v1/chat/create or /api/v1/chat
      const response = await this.client.post(
        `/api/v1/chat/create?password=${encodeURIComponent(this.password)}`,
        { addresses: [address] }
      );
      
      console.log(`   ✅ Chat created! GUID: ${response.data.guid}`);
      return response.data.guid;
    } catch (error) {
      console.error(`   ❌ Failed to create chat:`, error.response?.data || error.message);
      
      // Try alternative endpoint
      try {
        console.log(`   Trying alternative endpoint...`);
        const altResponse = await this.client.post(
          `/api/v1/chat?password=${encodeURIComponent(this.password)}`,
          { addresses: [address] }
        );
        console.log(`   ✅ Chat created via alt endpoint! GUID: ${altResponse.data.guid}`);
        return altResponse.data.guid;
      } catch (altError) {
        console.error(`   ❌ Alternative also failed:`, altError.response?.data || altError.message);
        throw new Error(`Cannot create chat: ${error.message}`);
      }
    }
  }

  /**
   * Get or create a chat GUID for an address
   */
  async getOrCreateChat(address) {
    try {
      console.log(`🔍 Getting/Creating chat for: ${address}`);
      
      // First, try to get existing chats (this might be /api/v1/chats or /api/v1/chat)
      let existingChats = null;
      try {
        const response = await this.client.get(`/api/v1/chat?password=${encodeURIComponent(this.password)}`);
        existingChats = response.data;
      } catch (e) {
        // Try alternative endpoint
        try {
          const response = await this.client.get(`/api/v1/chats?password=${encodeURIComponent(this.password)}`);
          existingChats = response.data;
        } catch (e2) {
          console.log(`   Could not fetch existing chats, will create new one`);
        }
      }
      
      // If we got existing chats, search for this address
      if (existingChats && Array.isArray(existingChats)) {
        const existingChat = existingChats.find(chat => {
          if (chat.displayName === address) return true;
          if (chat.participants && Array.isArray(chat.participants)) {
            return chat.participants.some(p => p.address === address);
          }
          return false;
        });
        
        if (existingChat) {
          console.log(`   ✅ Found existing chat: ${existingChat.guid}`);
          return existingChat.guid;
        }
      }
      
      // No existing chat found, create a new one
      return await this.createChat(address);
      
    } catch (error) {
      console.error(`❌ Failed to get/create chat:`, error.message);
      throw error;
    }
  }

  /**
   * Send a message to a chat GUID
   */
  async sendToChat({ chatGuid, message, effectId }) {
    try {
      console.log(`📱 Sending iMessage to chat: ${chatGuid}`);
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
   * Send a message - main entry point
   */
  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      // Step 1: Get or create a chat GUID
      const chatGuid = await this.getOrCreateChat(to);
      console.log(`   Using chat GUID: ${chatGuid}`);
      
      // Step 2: Send message to that chat
      return await this.sendToChat({ chatGuid, message, effectId });
      
    } catch (error) {
      console.error(`❌ Error sending message:`, error.message);
      throw error;
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
      
      // Step 1: Get or create a chat GUID
      const chatGuid = await this.getOrCreateChat(to);
      console.log(`   Using chat GUID: ${chatGuid}`);
      
      // Step 2: Send attachment to that chat
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
    } catch (error) {
      console.error('BlueBubbles attachment error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage with attachment: ${error.message}`);
    }
  }

  async getStatus() {
    try {
      // Try the ping endpoint
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