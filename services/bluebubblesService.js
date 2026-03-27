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
        'Authorization': `Bearer ${password}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   From: ${from}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      console.log(`   Using password: ${this.password ? '***' + this.password.slice(-4) : 'MISSING'}`);
      
      const payload = { 
        text: message, 
        to: to, 
        from: from 
      };
      if (effectId) payload.effectId = effectId;
      
      const response = await this.client.post('/api/v1/message/text', payload);
      
      console.log(`✅ iMessage sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error('BlueBubbles send error:', error.response?.data || error.message);
      console.error('   Status:', error.response?.status);
      console.error('   Headers:', error.response?.headers);
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

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
      
      const response = await this.client.post('/api/v1/message/attachment', payload);
      
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
      const response = await this.client.get('/api/v1/ping');
      return {
        connected: response.status === 200,
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
      const response = await this.client.get('/api/v1/chats', { 
        params: { limit } 
      });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch chats:', error.message);
      throw error;
    }
  }
}

export default BlueBubblesService;