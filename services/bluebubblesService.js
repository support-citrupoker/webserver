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
      timeout: 60000  // 60 seconds timeout
    });
  }

  /**
   * Generate the correct chatGuid format
   * For iMessage/SMS to phone: "any;-;+phone"
   * For iMessage to email: "any;-;email@domain.com"
   */
  generateChatGuid(address) {
    let cleanAddress = address;
    // Format phone numbers correctly (add + if missing)
    if (address && !address.includes('@') && !address.startsWith('+')) {
      cleanAddress = `+${address.replace(/\D/g, '')}`;
    }
    return `any;-;${cleanAddress}`;
  }

  /**
   * Send a text iMessage using the correct API format
   * Endpoint: /api/v1/message/text?password=xxx
   * Required fields: chatGuid, tempGuid, message
   */
  async sendMessage({ to, from, message, effectId, replyToGuid }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      const chatGuid = this.generateChatGuid(to);
      const tempGuid = `temp-${uuidv4()}`;
      
      // Build the payload according to the official documentation
      const payload = {
        chatGuid: chatGuid,
        tempGuid: tempGuid,
        message: message
      };
      
      // Add optional fields if provided
      if (effectId) payload.effectId = effectId;
      if (replyToGuid) payload.selectedMessageGuid = replyToGuid;
      if (from) payload.from = from;
      
      console.log(`   Chat GUID: ${chatGuid}`);
      console.log(`   Temp GUID: ${tempGuid}`);
      
      const response = await this.client.post(
        `/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
        payload
      );
      
      console.log(`✅ iMessage sent! Response status: ${response.data.status}`);
      console.log(`   Message GUID: ${response.data.data?.guid}`);
      
      return {
        success: true,
        guid: response.data.data?.guid,
        timestamp: new Date().toISOString(),
        response: response.data
      };
    } catch (error) {
      console.error('❌ BlueBubbles send error:', error.message);
      if (error.response?.data) {
        console.error('   Response data:', error.response.data);
      }
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send an iMessage with attachment
   * Endpoint: /api/v1/message/attachment?password=xxx
   */
  async sendAttachment({ to, from, message, mediaUrl, effectId }) {
    try {
      console.log(`📸 Sending iMessage with attachment:`);
      console.log(`   To: ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      const chatGuid = this.generateChatGuid(to);
      const tempGuid = `temp-${uuidv4()}`;
      
      // For attachments, use FormData
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('chatGuid', chatGuid);
      formData.append('tempGuid', tempGuid);
      if (message) formData.append('message', message);
      if (effectId) formData.append('effectId', effectId);
      if (from) formData.append('from', from);
      
      // Handle attachment - support both URLs and local files
      if (mediaUrl.startsWith('http')) {
        // Download the file and attach
        console.log(`   Downloading attachment from URL...`);
        const fileResponse = await axios.get(mediaUrl, { 
          responseType: 'arraybuffer',
          timeout: 30000 
        });
        const fileName = mediaUrl.split('/').pop() || 'attachment';
        const buffer = Buffer.from(fileResponse.data);
        formData.append('attachment', buffer, fileName);
      } else {
        // Assume it's a local file path
        const fs = await import('fs');
        if (fs.existsSync(mediaUrl)) {
          const fileBuffer = fs.readFileSync(mediaUrl);
          const fileName = mediaUrl.split('/').pop();
          formData.append('attachment', fileBuffer, fileName);
        } else {
          throw new Error(`File not found: ${mediaUrl}`);
        }
      }
      
      const response = await this.client.post(
        `/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`,
        formData,
        {
          headers: {
            ...formData.getHeaders()
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
      console.error('❌ BlueBubbles attachment error:', error.message);
      throw new Error(`Failed to send iMessage with attachment: ${error.message}`);
    }
  }

  /**
   * Query chats to find existing conversations
   * Endpoint: POST /api/v1/chat/query?password=xxx
   */
  async queryChats(limit = 20, offset = 0) {
    try {
      console.log(`🔍 Querying chats (limit: ${limit})...`);
      
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
   * Endpoint: GET /api/v1/chat/{chatGuid}/message?password=xxx
   */
  async getChatMessages(chatGuid, limit = 25, offset = 0, sort = 'DESC') {
    try {
      const encodedGuid = encodeURIComponent(chatGuid);
      const response = await this.client.get(
        `/api/v1/chat/${encodedGuid}/message?password=${encodeURIComponent(this.password)}`,
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
   * Endpoint: GET /api/v1/message?password=xxx
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
   * Get server status
   * Endpoint: GET /api/v1/ping?password=xxx
   */
  async getStatus() {
    try {
      console.log(`🔍 Checking BlueBubbles server status...`);
      const startTime = Date.now();
      
      const response = await this.client.get(`/api/v1/ping?password=${encodeURIComponent(this.password)}`);
      
      const elapsed = Date.now() - startTime;
      console.log(`   Response time: ${elapsed}ms`);
      console.log(`   Server status: ${response.data.status}`);
      
      return {
        connected: response.status === 200,
        serverUrl: this.serverUrl,
        data: response.data,
        responseTime: elapsed,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('BlueBubbles status error:', error.message);
      return {
        connected: false,
        serverUrl: this.serverUrl,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Check if a contact has iMessage
   * Endpoint: GET /api/v1/handle/availability/imessage?password=xxx&address=xxx
   */
  async checkiMessageAvailability(address) {
    try {
      console.log(`🔍 Checking iMessage availability for: ${address}`);
      
      const response = await this.client.get(
        `/api/v1/handle/availability/imessage?password=${encodeURIComponent(this.password)}`,
        { params: { address: address } }
      );
      
      const isAvailable = response.data.data?.available === true;
      console.log(`   ${address}: ${isAvailable ? 'Has iMessage ✅' : 'SMS only ❌'}`);
      
      return {
        hasiMessage: isAvailable,
        service: response.data.data?.service || (isAvailable ? 'iMessage' : 'SMS'),
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

  /**
   * Get server info
   * Endpoint: GET /api/v1/server?password=xxx
   */
  async getServerInfo() {
    try {
      const response = await this.client.get(`/api/v1/server?password=${encodeURIComponent(this.password)}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get server info:', error.message);
      return null;
    }
  }

  /**
   * Test connection with a simple ping
   */
  async testConnection() {
    try {
      console.log(`🧪 Testing BlueBubbles connection...`);
      const status = await this.getStatus();
      
      if (status.connected) {
        console.log(`✅ BlueBubbles connection successful!`);
        console.log(`   Server: ${status.serverUrl}`);
        console.log(`   Response time: ${status.responseTime}ms`);
        console.log(`   Server message: ${status.data?.message}`);
        return true;
      } else {
        console.log(`❌ BlueBubbles connection failed: ${status.error}`);
        return false;
      }
    } catch (error) {
      console.error(`❌ Connection test failed:`, error.message);
      return false;
    }
  }
}

export default BlueBubblesService;