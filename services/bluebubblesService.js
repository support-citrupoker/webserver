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
   * Get or create a chat for a phone number/email
   * This is the key method - we need a chat GUID to send messages
   */
  async getOrCreateChat(address) {
    try {
      console.log(`🔍 Getting/Creating chat for: ${address}`);
      
      // First, try to find existing chat
      const chatsResponse = await this.client.get(`/api/v1/chats?password=${encodeURIComponent(this.password)}`);
      const chats = chatsResponse.data;
      
      // Find chat by phone number or email
      let existingChat = null;
      
      if (chats && Array.isArray(chats)) {
        existingChat = chats.find(chat => {
          // Check by display name
          if (chat.displayName === address) return true;
          
          // Check participants
          if (chat.participants && Array.isArray(chat.participants)) {
            return chat.participants.some(p => p.address === address);
          }
          
          return false;
        });
      }
      
      if (existingChat) {
        console.log(`   ✅ Found existing chat: ${existingChat.guid}`);
        return { chatGuid: existingChat.guid, isNew: false };
      }
      
      // If no existing chat, create one
      console.log(`   📝 No existing chat found, creating new chat...`);
      
      // Create a new chat with the address
      const createResponse = await this.client.post(
        `/api/v1/chat/create?password=${encodeURIComponent(this.password)}`,
        { addresses: [address] }
      );
      
      const newChat = createResponse.data;
      console.log(`   ✅ Created new chat: ${newChat.guid}`);
      return { chatGuid: newChat.guid, isNew: true };
      
    } catch (error) {
      console.error(`   ❌ Failed to get/create chat:`, error.response?.data || error.message);
      throw new Error(`Cannot get/create chat: ${error.message}`);
    }
  }

  /**
   * Send a text iMessage using a chat GUID
   */
  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      // STEP 1: Get or create the chat
      const { chatGuid, isNew } = await this.getOrCreateChat(to);
      console.log(`   Using chat GUID: ${chatGuid} ${isNew ? '(new)' : '(existing)'}`);
      
      // STEP 2: Send message to the chat
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
      console.error(`   Status: ${error.response?.status}`);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send an iMessage with attachment
   */
  async sendAttachment({ to, from, message, mediaUrl, effectId }) {
    try {
      console.log(`📸 Sending iMessage with attachment:`);
      console.log(`   To: ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      // STEP 1: Get or create the chat
      const { chatGuid, isNew } = await this.getOrCreateChat(to);
      console.log(`   Using chat GUID: ${chatGuid} ${isNew ? '(new)' : '(existing)'}`);
      
      // STEP 2: Send attachment to the chat
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

  /**
   * Get chat GUID for a phone number/email (without creating)
   */
  async getChatGuid(address) {
    try {
      console.log(`🔍 Looking up chat GUID for: ${address}`);
      
      const response = await this.client.get(`/api/v1/chats?password=${encodeURIComponent(this.password)}`);
      const chats = response.data;
      
      if (chats && Array.isArray(chats)) {
        const chat = chats.find(c => 
          c.displayName === address || 
          c.participants?.some(p => p.address === address)
        );
        
        if (chat) {
          console.log(`   Found chat GUID: ${chat.guid}`);
          return chat.guid;
        }
      }
      
      console.log(`   No existing chat found for ${address}`);
      return null;
    } catch (error) {
      console.error('Failed to get chat GUID:', error.message);
      return null;
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