// services/bluebubbles.service.js
import axios from 'axios';
import { randomUUID } from 'crypto';

class BlueBubblesService {
  constructor() {
    this.serverUrl = process.env.BLUEBUBBLES_SERVER_URL || 'http://localhost:3030';
    this.password = process.env.BLUEBUBBLES_PASSWORD;
    this.imessageAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT;
    
    if (!this.password) {
      console.error('❌ BLUEBUBBLES_PASSWORD not set');
    }
    
    this.client = axios.create({
      timeout: 30000
    });
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Server URL: ${this.serverUrl}`);
    console.log(`   Password: ${this.password ? '***' : 'Not set'}`);
    console.log(`   Full Base URL: ${this.serverUrl}/api/v1/message/text`);
  }

  generateTempGuid() {
    const uuid = randomUUID();
    return `temp-${uuid}`;
  }

  formatPhoneNumber(phone) {
    if (!phone) return phone;
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.substring(1);
    }
    return `+${cleaned}`;
  }

  async sendMessage({ to, message, from = null, effectId = null }) {
    try {
      console.log(`\n📱 ===== BLUEBUBBLES SEND DEBUG =====`);
      console.log(`   Original "to" value: ${to}`);
      console.log(`   Original message: ${message}`);
      
      // Format the chat GUID
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        chatGuid = this.formatPhoneNumber(to);
      }
      
      // Generate tempGuid
      const tempGuid = this.generateTempGuid();
      
      // Build the FULL URL with password
      const endpoint = '/api/v1/message/text';
      const fullUrl = `${this.serverUrl}${endpoint}`;
      const urlWithPassword = `${fullUrl}?password=${this.password}`;
      
      console.log(`\n📍 URL DEBUG:`);
      console.log(`   Server URL from env: ${this.serverUrl}`);
      console.log(`   Endpoint: ${endpoint}`);
      console.log(`   Full URL (no password): ${fullUrl}`);
      console.log(`   Full URL WITH password: ${urlWithPassword}`);
      console.log(`   Password length: ${this.password?.length || 0} chars`);
      console.log(`   Password first 5 chars: ${this.password?.substring(0, 5)}...`);
      
      const payload = {
        chatGuid: chatGuid,
        tempGuid: tempGuid,
        message: message
      };
      
      console.log(`\n📦 PAYLOAD DEBUG:`);
      console.log(`   chatGuid: ${chatGuid}`);
      console.log(`   tempGuid: ${tempGuid}`);
      console.log(`   message: ${message}`);
      console.log(`   Full payload:`, JSON.stringify(payload, null, 2));
      
      console.log(`\n🔧 REQUEST DEBUG:`);
      console.log(`   HTTP Method: POST`);
      console.log(`   Content-Type: application/json`);
      console.log(`   Timeout: 30000ms`);
      
      // Make the request
      const response = await this.client.post(urlWithPassword, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`\n📥 RESPONSE DEBUG:`);
      console.log(`   Status: ${response.status}`);
      console.log(`   Status Text: ${response.statusText}`);
      console.log(`   Data:`, JSON.stringify(response.data, null, 2));
      
      if (response.data && response.data.status === 200) {
        console.log(`   ✅ Message sent successfully!`);
        return {
          success: true,
          guid: response.data.data?.guid,
          messageId: response.data.data?.guid,
          tempGuid: tempGuid
        };
      } else {
        throw new Error(response.data?.message || 'Unknown error');
      }
      
    } catch (error) {
      console.log(`\n❌ ERROR DEBUG:`);
      console.log(`   Error name: ${error.name}`);
      console.log(`   Error message: ${error.message}`);
      
      if (error.response) {
        console.log(`   Response status: ${error.response.status}`);
        console.log(`   Response status text: ${error.response.statusText}`);
        console.log(`   Response headers:`, JSON.stringify(error.response.headers, null, 2));
        console.log(`   Response data:`, JSON.stringify(error.response.data, null, 2));
        
        if (error.response.status === 401) {
          console.error(`   ⚠️ Authentication failed - password may be incorrect`);
          console.error(`   Password used: ${this.password?.substring(0, 3)}...`);
        } else if (error.response.status === 404) {
          console.error(`   ⚠️ Endpoint not found - check if BlueBubbles server is running`);
          console.error(`   Tried URL: ${urlWithPassword}`);
          console.error(`   Make sure the server URL is correct and includes /api/v1`);
        } else if (error.response.status === 500) {
          console.error(`   ⚠️ Server error - check Messages app on Mac`);
        }
      } else if (error.code === 'ECONNREFUSED') {
        console.error(`   ⚠️ Connection refused - cannot reach ${this.serverUrl}`);
        console.error(`   Make sure BlueBubbles server is running on your Mac`);
      } else if (error.code === 'ENOTFOUND') {
        console.error(`   ⚠️ DNS lookup failed - invalid server URL`);
        console.error(`   Check BLUEBUBBLES_SERVER_URL in .env file`);
      } else {
        console.error(`   Error code: ${error.code}`);
        console.error(`   Error details:`, error);
      }
      
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  async getStatus() {
    try {
      const pingUrl = `${this.serverUrl}/api/v1/ping?password=${this.password}`;
      console.log(`📍 Testing connection to: ${pingUrl}`);
      const response = await this.client.get(pingUrl);
      return { success: true, status: response.data, url: this.serverUrl };
    } catch (error) {
      console.error('Failed to get status:', error.message);
      return { success: false, error: error.message, url: this.serverUrl };
    }
  }
}

export default BlueBubblesService;