// services/bluebubblesService.js
import axios from 'axios';

class BlueBubblesService {
  constructor(serverUrl, password) {
    this.serverUrl = serverUrl;
    this.password = password;
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Server URL: ${serverUrl}`);
    console.log(`   Password: ${password ? '***' + password.slice(-4) : 'MISSING'}`);
    console.log(`   Password length: ${password?.length || 0}`);
    
    // Create axios instance WITHOUT auth header - we'll add password as query param
    this.client = axios.create({
      baseURL: serverUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  /**
   * Send a text iMessage
   * CORRECT: Password goes in query parameter, not Authorization header
   */
  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   From: ${from}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      console.log(`   Password: ${this.password ? '***' + this.password.slice(-4) : 'MISSING'}`);
      
      const payload = { 
        text: message, 
        to: to, 
        from: from 
      };
      if (effectId) payload.effectId = effectId;
      
      // CORRECT: Password as query parameter
      const response = await this.client.post(`/api/v1/message/text?password=${encodeURIComponent(this.password)}`, payload);
      
      console.log(`✅ iMessage sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   URL attempted: ${this.serverUrl}/api/v1/message/text?password=***`);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send an iMessage with attachment
   */
  async sendAttachment({ to, from, message, mediaUrl, effectId }) {
    try {
      console.log(`📸 Sending iMessage with attachment via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   From: ${from}`);
      console.log(`   Media URL: ${mediaUrl}`);
      console.log(`   Message: ${message?.substring(0, 100) || '(no text)'}`);
      
      const payload = { 
        to: to, 
        from: from, 
        text: message || '', 
        attachment: mediaUrl 
      };
      if (effectId) payload.effectId = effectId;
      
      // CORRECT: Password as query parameter
      const response = await this.client.post(`/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`, payload);
      
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

  /**
   * Check server status
   */
  async getStatus() {
    try {
      console.log(`\n🔍 Testing BlueBubbles connection...`);
      
      // CORRECT: Password as query parameter
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

  /**
   * Get recent chats
   */
  async getChats(limit = 20) {
    try {
      // CORRECT: Password as query parameter
      const response = await this.client.get(`/api/v1/chats?password=${encodeURIComponent(this.password)}`, { 
        params: { limit } 
      });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch chats:', error.message);
      throw error;
    }
  }

  /**
   * Check if a contact has iMessage
   */
  async checkiMessageAvailability(address) {
    try {
      const cleanAddress = address.trim();
      
      // CORRECT: Password as query parameter
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