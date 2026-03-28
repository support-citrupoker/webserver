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
    
    // Create two clients for different auth methods
    // Client 1: Bearer token authentication (for /api/v1/message/send)
    this.bearerClient = axios.create({
      baseURL: serverUrl,
      headers: {
        'Authorization': `Bearer ${password}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });
    
    // Client 2: Query parameter authentication (for legacy endpoints)
    this.queryClient = axios.create({
      baseURL: serverUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });
  }

  /**
   * Generate the correct chatGuid format
   * For iMessage: "iMessage;+;+phone" or "iMessage;+;email@domain.com"
   */
  generateChatGuid(address, forceSMS = false) {
    let cleanAddress = address;
    if (address && !address.includes('@') && !address.startsWith('+')) {
      cleanAddress = `+${address.replace(/\D/g, '')}`;
    }
    
    if (forceSMS) {
      return `SMS;-;${cleanAddress}`;
    }
    return `iMessage;+;${cleanAddress}`;
  }

  /**
   * Send a text iMessage using the /api/v1/message/send endpoint (recommended)
   * This uses Bearer token authentication
   */
  async sendMessage({ to, from, message, effectId, replyToGuid, chatGuid }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      const tempGuid = uuidv4();
      const targetChatGuid = chatGuid || this.generateChatGuid(to);
      
      // Build the payload according to the correct format
      const payload = {
        chatGuid: targetChatGuid,
        tempGuid: tempGuid,
        handle: to,           // recipient's phone number or email
        text: message,        // message content
        subject: null,        // optional subject
        effectId: effectId || null,  // optional effect (slam, loud, gentle, invisible ink)
        selectedMessageGuid: replyToGuid || null  // for replies
      };
      
      console.log(`   Chat GUID: ${targetChatGuid}`);
      console.log(`   Temp GUID: ${tempGuid}`);
      console.log(`   Using endpoint: /api/v1/message/send`);
      
      // Use bearer client for this endpoint
      const response = await this.bearerClient.post('/api/v1/message/send', payload);
      
      console.log(`✅ iMessage sent! Response:`, response.data);
      return {
        success: true,
        guid: response.data.guid || response.data.data?.guid,
        timestamp: new Date().toISOString(),
        response: response.data
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.message);
      if (error.response?.data) {
        console.error('   Response data:', error.response.data);
      }
      
      // Fallback to legacy endpoint if this fails
      console.log(`   🔄 Falling back to legacy endpoint...`);
      return await this.sendMessageLegacy({ to, from, message, effectId, replyToGuid });
    }
  }

  /**
   * Legacy method using /api/v1/message/text with query parameter auth
   */
  async sendMessageLegacy({ to, from, message, effectId, replyToGuid }) {
    try {
      console.log(`   Using legacy endpoint: /api/v1/message/text`);
      
      const chatGuid = this.generateChatGuid(to);
      const tempGuid = uuidv4();
      
      const payload = {
        chatGuid: chatGuid,
        tempGuid: tempGuid,
        message: message,
        method: "apple-script",
        subject: "",
        effectId: effectId || "",
        selectedMessageGuid: replyToGuid || ""
      };
      
      const response = await this.queryClient.post(
        `/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
        payload
      );
      
      console.log(`✅ iMessage sent via legacy!`);
      return {
        success: true,
        guid: response.data.data?.guid,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Legacy send also failed:', error.message);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send a message as SMS (force SMS mode)
   */
  async sendSMS({ to, from, message }) {
    try {
      console.log(`\n📱 Sending SMS via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      
      const tempGuid = uuidv4();
      const chatGuid = this.generateChatGuid(to, true); // forceSMS = true
      
      const payload = {
        chatGuid: chatGuid,
        tempGuid: tempGuid,
        handle: to,
        text: message,
        subject: null,
        effectId: null,
        selectedMessageGuid: null
      };
      
      const response = await this.bearerClient.post('/api/v1/message/send', payload);
      
      console.log(`✅ SMS sent! Response:`, response.data);
      return {
        success: true,
        guid: response.data.guid,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('BlueBubbles SMS error:', error.message);
      throw new Error(`Failed to send SMS: ${error.message}`);
    }
  }

  /**
   * Send an iMessage with attachment
   */
  async sendAttachment({ to, from, message, mediaUrl, effectId, replyToGuid }) {
    try {
      console.log(`📸 Sending iMessage with attachment:`);
      console.log(`   To: ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      // First, try the attachment endpoint with bearer auth
      const tempGuid = uuidv4();
      const chatGuid = this.generateChatGuid(to);
      
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('chatGuid', chatGuid);
      formData.append('tempGuid', tempGuid);
      formData.append('handle', to);
      formData.append('text', message || '');
      if (effectId) formData.append('effectId', effectId);
      if (replyToGuid) formData.append('selectedMessageGuid', replyToGuid);
      
      // Handle attachment
      if (mediaUrl.startsWith('http')) {
        const fileResponse = await axios.get(mediaUrl, { 
          responseType: 'arraybuffer',
          timeout: 30000 
        });
        const fileName = mediaUrl.split('/').pop() || 'attachment';
        const buffer = Buffer.from(fileResponse.data);
        formData.append('attachment', buffer, fileName);
      } else {
        const fs = await import('fs');
        const fileBuffer = fs.readFileSync(mediaUrl);
        const fileName = mediaUrl.split('/').pop();
        formData.append('attachment', fileBuffer, fileName);
      }
      
      const response = await this.bearerClient.post('/api/v1/message/attachment', formData, {
        headers: {
          ...formData.getHeaders()
        }
      });
      
      console.log(`✅ iMessage with attachment sent!`);
      return {
        success: true,
        guid: response.data.guid,
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
      
      const response = await this.bearerClient.post('/api/v1/chat/query', { limit, offset });
      
      return response.data.data || response.data.chats || [];
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
      const response = await this.bearerClient.get(
        `/api/v1/chat/${encodedGuid}/message`,
        { params: { limit, offset, sort } }
      );
      
      return response.data.data || response.data.messages || [];
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
      const response = await this.bearerClient.get(
        '/api/v1/message',
        { params: { limit, offset, sort } }
      );
      
      return response.data.data || response.data.messages || [];
    } catch (error) {
      console.error('Failed to get recent messages:', error.message);
      return [];
    }
  }

  /**
   * Get server status using ping endpoint
   */
  async getStatus() {
    try {
      console.log(`🔍 Checking BlueBubbles server status...`);
      const startTime = Date.now();
      
      // Try bearer auth first
      const response = await this.bearerClient.get('/api/v1/ping');
      
      const elapsed = Date.now() - startTime;
      console.log(`   Response time: ${elapsed}ms`);
      
      return {
        connected: true,
        serverUrl: this.serverUrl,
        data: response.data,
        responseTime: elapsed,
        authMethod: 'bearer',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      // Fallback to query param
      try {
        const response = await this.queryClient.get(`/api/v1/ping?password=${encodeURIComponent(this.password)}`);
        return {
          connected: true,
          serverUrl: this.serverUrl,
          data: response.data,
          authMethod: 'query',
          timestamp: new Date().toISOString()
        };
      } catch (fallbackError) {
        return {
          connected: false,
          serverUrl: this.serverUrl,
          error: fallbackError.message,
          timestamp: new Date().toISOString()
        };
      }
    }
  }

  /**
   * Check if a contact has iMessage
   */
  async checkiMessageAvailability(address) {
    try {
      console.log(`🔍 Checking iMessage availability for: ${address}`);
      
      const response = await this.bearerClient.get(
        '/api/v1/handle/availability/imessage',
        { params: { address: address } }
      );
      
      const isAvailable = response.data.available === true || response.data.data?.available === true;
      console.log(`   ${address}: ${isAvailable ? 'Has iMessage ✅' : 'SMS only ❌'}`);
      
      return {
        hasiMessage: isAvailable,
        service: response.data.service || (isAvailable ? 'iMessage' : 'SMS'),
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
        console.log(`   Response time: ${status.responseTime || 'N/A'}ms`);
        console.log(`   Auth method: ${status.authMethod}`);
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