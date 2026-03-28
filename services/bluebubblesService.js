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
    
    // Create axios instance with increased timeout (60 seconds)
    this.client = axios.create({
      baseURL: serverUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000,  // Increased from 30000 to 60000 (60 seconds)
      // Add retry logic for network issues
      maxRetries: 2,
      retryDelay: 1000
    });
    
    // Add request interceptor for debugging
    this.client.interceptors.request.use(request => {
      console.log(`\n📤 BlueBubbles Request:`);
      console.log(`   URL: ${request.method.toUpperCase()} ${request.url}`);
      console.log(`   Timeout: ${request.timeout}ms`);
      if (request.data && !(request.data instanceof FormData)) {
        console.log(`   Body:`, JSON.stringify(request.data, null, 2).substring(0, 500));
      }
      return request;
    });
    
    // Add response interceptor for debugging
    this.client.interceptors.response.use(
      response => {
        console.log(`📥 BlueBubbles Response: ${response.status} (${response.statusText})`);
        return response;
      },
      error => {
        if (error.code === 'ECONNABORTED') {
          console.error(`❌ BlueBubbles Request TIMEOUT after ${error.config?.timeout || 'unknown'}ms`);
        } else if (error.response) {
          console.error(`❌ BlueBubbles Error: ${error.response.status} - ${error.response.statusText}`);
          console.error(`   Data:`, error.response.data);
        } else if (error.request) {
          console.error(`❌ BlueBubbles No Response: ${error.message}`);
        } else {
          console.error(`❌ BlueBubbles Error: ${error.message}`);
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Generate a chatGuid for a phone number or email
   * Format: any;-;+phone OR any;-;email
   */
  generateChatGuid(address) {
    // Ensure phone numbers have + prefix
    let formattedAddress = address;
    if (address && !address.includes('@') && !address.startsWith('+')) {
      formattedAddress = `+${address.replace(/\D/g, '')}`;
    }
    return `any;-;${formattedAddress}`;
  }

  /**
   * Send a text iMessage
   */
  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      console.log(`   Timeout: ${this.client.defaults.timeout}ms`);
      
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
      
      // Add effect if provided (slam, loud, gentle, invisible ink)
      if (effectId) {
        payload.effectId = effectId;
      }
      
      console.log(`   Chat GUID: ${chatGuid}`);
      console.log(`   Temp GUID: ${tempGuid}`);
      
      const response = await this.client.post(
        `/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
        payload
      );
      
      console.log(`✅ iMessage sent! Response:`, response.data);
      return {
        success: true,
        guid: response.data.data?.guid,
        timestamp: new Date().toISOString(),
        response: response.data
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.message);
      if (error.response?.data) {
        console.error('   Response data:', error.response.data);
      }
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
      console.log(`   Timeout: ${this.client.defaults.timeout}ms`);
      
      const chatGuid = this.generateChatGuid(to);
      const tempGuid = `temp-${uuidv4()}`;
      
      // For attachments, use FormData
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('chatGuid', chatGuid);
      formData.append('tempGuid', tempGuid);
      if (message) formData.append('message', message);
      if (from) formData.append('from', from);
      if (effectId) formData.append('effectId', effectId);
      
      // Handle attachment
      if (mediaUrl.startsWith('http')) {
        // Download the file and attach
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
        const fileBuffer = fs.readFileSync(mediaUrl);
        const fileName = mediaUrl.split('/').pop();
        formData.append('attachment', fileBuffer, fileName);
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
      console.error('BlueBubbles attachment error:', error.message);
      throw new Error(`Failed to send iMessage with attachment: ${error.message}`);
    }
  }

  /**
   * Query chats to find existing conversations
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

  /**
   * Get server status
   */
  async getStatus() {
    try {
      console.log(`🔍 Checking BlueBubbles server status...`);
      const startTime = Date.now();
      
      const response = await this.client.get(`/api/v1/ping?password=${encodeURIComponent(this.password)}`);
      
      const elapsed = Date.now() - startTime;
      console.log(`   Response time: ${elapsed}ms`);
      
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
        console.log(`   Version: ${status.data?.version || 'unknown'}`);
      } else {
        console.log(`❌ BlueBubbles connection failed: ${status.error}`);
      }
      
      return status;
    } catch (error) {
      console.error(`❌ Connection test failed:`, error.message);
      return { connected: false, error: error.message };
    }
  }
}

export default BlueBubblesService;