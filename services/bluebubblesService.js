// services/bluebubblesService.js
import axios from 'axios';

class BlueBubblesService {
  constructor(serverUrl, password) {
    this.serverUrl = serverUrl;
    this.password = password;
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Server URL: ${serverUrl}`);
    console.log(`   Password: ${password ? '***' + password.slice(-4) : 'MISSING'}`);
    console.log(`   Full Password (for debugging): "${password}"`);
    console.log(`   Password length: ${password?.length || 0}`);
    console.log(`   Password characters: ${password ? password.split('').map(c => c === ' ' ? '[SPACE]' : c).join('') : 'none'}`);
    
    this.client = axios.create({
      baseURL: serverUrl,
      headers: {
        'Authorization': `Bearer ${password}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    // Add request interceptor to debug outgoing requests
    this.client.interceptors.request.use(request => {
      console.log(`\n📤 BlueBubbles Request:`);
      console.log(`   URL: ${request.method.toUpperCase()} ${request.url}`);
      console.log(`   Full URL: ${request.baseURL}${request.url}`);
      console.log(`   Headers:`, JSON.stringify(request.headers, null, 2));
      if (request.data) {
        console.log(`   Body:`, JSON.stringify(request.data, null, 2));
      }
      return request;
    });
    
    this.client.interceptors.response.use(
      response => {
        console.log(`📥 BlueBubbles Response: ${response.status}`);
        console.log(`   Data:`, response.data);
        return response;
      },
      error => {
        console.error(`\n❌ BlueBubbles Error:`);
        console.error(`   Status: ${error.response?.status}`);
        console.error(`   Status Text: ${error.response?.statusText}`);
        console.error(`   Data:`, error.response?.data);
        console.error(`   Headers:`, error.response?.headers);
        
        // Log the exact request that failed
        if (error.config) {
          console.error(`\n📤 Failed Request Details:`);
          console.error(`   URL: ${error.config.url}`);
          console.error(`   Method: ${error.config.method}`);
          console.error(`   Headers:`, error.config.headers);
          console.error(`   Data:`, error.config.data);
        }
        return Promise.reject(error);
      }
    );
  }

  async sendMessage({ to, from, message, effectId }) {
    try {
      console.log(`\n📱 ===== SENDING IMESSAGE =====`);
      console.log(`   To: ${to}`);
      console.log(`   From: ${from}`);
      console.log(`   Message: ${message?.substring(0, 100)}`);
      console.log(`   Password being used: "${this.password}"`);
      console.log(`   Password length: ${this.password?.length}`);
      
      const payload = { 
        text: message, 
        to: to, 
        from: from 
      };
      if (effectId) payload.effectId = effectId;
      
      console.log(`\n🔄 Attempt 1: Sending with Bearer token in header...`);
      const response = await this.client.post('/api/v1/message/text', payload);
      
      console.log(`✅ iMessage sent! GUID: ${response.data.guid}`);
      return {
        success: true,
        guid: response.data.guid,
        timestamp: response.data.timestamp
      };
    } catch (error) {
      console.error(`\n❌ Bearer token method failed:`, error.response?.data || error.message);
      
      // If Bearer token fails, try with query parameter
      if (error.response?.status === 401) {
        console.log(`\n🔄 Attempt 2: Trying with query parameter password...`);
        console.log(`   URL: ${this.serverUrl}/api/v1/message/text?password=${this.password}`);
        try {
          const altResponse = await axios.post(
            `${this.serverUrl}/api/v1/message/text?password=${this.password}`,
            payload,
            { 
              headers: { 
                'Content-Type': 'application/json'
              } 
            }
          );
          console.log(`✅ iMessage sent with query param! GUID: ${altResponse.data.guid}`);
          return {
            success: true,
            guid: altResponse.data.guid,
            timestamp: altResponse.data.timestamp
          };
        } catch (altError) {
          console.error(`❌ Query param also failed:`);
          console.error(`   Status: ${altError.response?.status}`);
          console.error(`   Data:`, altError.response?.data);
          
          // Try with password in body
          console.log(`\n🔄 Attempt 3: Trying with password in body...`);
          try {
            const bodyResponse = await axios.post(
              `${this.serverUrl}/api/v1/message/text`,
              { ...payload, password: this.password },
              { headers: { 'Content-Type': 'application/json' } }
            );
            console.log(`✅ iMessage sent with body password! GUID: ${bodyResponse.data.guid}`);
            return {
              success: true,
              guid: bodyResponse.data.guid,
              timestamp: bodyResponse.data.timestamp
            };
          } catch (bodyError) {
            console.error(`❌ Body password also failed:`, bodyError.response?.data);
            throw new Error(`All authentication methods failed: ${error.message}`);
          }
        }
      }
      
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  async getStatus() {
    try {
      console.log(`\n🔍 Testing BlueBubbles connection...`);
      console.log(`   Password: "${this.password}"`);
      
      // Try Bearer token first
      const response = await this.client.get('/api/v1/ping');
      console.log(`✅ Bearer token works!`);
      return {
        connected: true,
        serverUrl: this.serverUrl,
        version: response.data?.version || 'unknown',
        timestamp: new Date().toISOString(),
        authMethod: 'bearer'
      };
    } catch (error) {
      console.log(`Bearer token failed, trying query param...`);
      try {
        const altResponse = await axios.get(
          `${this.serverUrl}/api/v1/ping?password=${this.password}`
        );
        console.log(`✅ Query param works!`);
        return {
          connected: true,
          serverUrl: this.serverUrl,
          version: altResponse.data?.version || 'unknown',
          timestamp: new Date().toISOString(),
          authMethod: 'query-param'
        };
      } catch (altError) {
        console.log(`Query param failed, trying no auth...`);
        try {
          const noAuthResponse = await axios.get(`${this.serverUrl}/api/v1/ping`);
          console.log(`✅ No auth works! (server might not require auth)`);
          return {
            connected: true,
            serverUrl: this.serverUrl,
            version: noAuthResponse.data?.version || 'unknown',
            timestamp: new Date().toISOString(),
            authMethod: 'none'
          };
        } catch (noAuthError) {
          return {
            connected: false,
            serverUrl: this.serverUrl,
            error: noAuthError.message,
            timestamp: new Date().toISOString()
          };
        }
      }
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