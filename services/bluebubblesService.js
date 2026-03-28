// services/bluebubblesService.js
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

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
   * Generate a chatGuid for a phone number or email
   * Format: any;-;+phone OR any;-;email
   */
  generateChatGuid(address) {
    return `any;-;${address}`;
  }

  /**
   * Send a text iMessage
   */
  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      const chatGuid = this.generateChatGuid(to);
      const tempGuid = `temp-${uuidv4()}`;
      
      const payload = {
        chatGuid: chatGuid,
        tempGuid: tempGuid,
        message: message
      };
      
      // Add optional from if provided (your iMessage account)
      if (from) {
        payload.from = from;
      }
      
      // Add effect if provided
      if (effectId) {
        payload.effectId = effectId;
      }
      
      const response = await this.client.post(
        `/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
        payload
      );
      
      console.log(`✅ iMessage sent! Response:`, response.data);
      return {
        success: true,
        guid: response.data.data?.guid,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
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
      
      const chatGuid = this.generateChatGuid(to);
      const tempGuid = `temp-${uuidv4()}`;
      
      // For attachments, we need to use FormData
      const formData = new FormData();
      formData.append('chatGuid', chatGuid);
      formData.append('tempGuid', tempGuid);
      if (message) formData.append('message', message);
      if (from) formData.append('from', from);
      if (effectId) formData.append('effectId', effectId);
      
      // If mediaUrl is a URL, we need to fetch it and attach as file
      // For now, assume it's a file path or we're passing the file directly
      if (mediaUrl.startsWith('http')) {
        // Download the file and attach
        const fileResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        const fileName = mediaUrl.split('/').pop() || 'attachment';
        const blob = new Blob([fileResponse.data]);
        formData.append('attachment', blob, fileName);
      } else {
        // Assume it's a local file path
        const fs = await import('fs');
        const fileBuffer = fs.readFileSync(mediaUrl);
        const blob = new Blob([fileBuffer]);
        const fileName = mediaUrl.split('/').pop();
        formData.append('attachment', blob, fileName);
      }
      
      const response = await this.client.post(
        `/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        }
      );
      
      console.log(`✅ iMessage with attachment sent!`);
      return {
        success: true,
        guid: response.data.data?.guid,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('BlueBubbles attachment error:', error.response?.data || error.message);
      throw new Error(`Failed to send iMessage with attachment: ${error.message}`);
    }
  }

  /**
   * Query chats to find existing conversations
   */
  async queryChats(limit = 20, offset = 0) {
    try {
      console.log(`🔍 Querying chats...`);
      
      const response = await this.client.post(
        `/api/v1/chat/query?password=${encodeURIComponent(this.password)}`,
        { limit, offset }
      );
      
      return response.data.data || [];
    } catch (error) {
      console.error('Failed to query chats:', error.message);
      return [];
    }
  }

  /**
   * Get messages from a specific chat
   */
  async getChatMessages(chatGuid, limit = 25, offset = 0, sort = 'DESC') {
    try {
      const response = await this.client.get(
        `/api/v1/chat/${encodeURIComponent(chatGuid)}/message?password=${encodeURIComponent(this.password)}`,
        { params: { limit, offset, sort } }
      );
      
      return response.data.data || [];
    } catch (error) {
      console.error('Failed to get chat messages:', error.message);
      return [];
    }
  }

  /**
   * Get recent messages across all chats
   */
  async getRecentMessages(limit = 10, offset = 0, sort = 'DESC') {
    try {
      const response = await this.client.get(
        `/api/v1/message?password=${encodeURIComponent(this.password)}`,
        { params: { limit, offset, sort } }
      );
      
      return response.data.data || [];
    } catch (error) {
      console.error('Failed to get recent messages:', error.message);
      return [];
    }
  }

  /**
   * Find a chat GUID for a phone number/email
   */
  async findChatByAddress(address) {
    try {
      const chats = await this.queryChats(100);
      const targetGuid = this.generateChatGuid(address);
      
      const chat = chats.find(c => 
        c.guid === targetGuid || 
        c.chatIdentifier === address ||
        c.participants?.some(p => p.address === address)
      );
      
      return chat?.guid || null;
    } catch (error) {
      console.error('Failed to find chat:', error.message);
      return null;
    }
  }

  async getStatus() {
    try {
      const response = await this.client.get(`/api/v1/ping?password=${encodeURIComponent(this.password)}`);
      return {
        connected: response.status === 200,
        serverUrl: this.serverUrl,
        data: response.data,
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
      // This uses the handle availability endpoint
      const response = await this.client.get(
        `/api/v1/handle/availability/imessage?password=${encodeURIComponent(this.password)}`,
        { params: { address: address } }
      );
      
      return {
        hasiMessage: response.data.data?.available === true,
        service: response.data.data?.service || (response.data.data?.available ? 'iMessage' : 'SMS'),
        address: address,
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