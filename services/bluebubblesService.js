// services/bluebubbles.service.js
import axios from 'axios';
import { randomUUID } from 'crypto';

class BlueBubblesService {
  constructor() {
    // Clean the server URL - remove trailing slash if present
    let rawUrl = process.env.BLUEBUBBLES_SERVER_URL || 'http://localhost:3030';
    this.serverUrl = rawUrl.replace(/\/$/, ''); // Remove trailing slash
    this.password = process.env.BLUEBUBBLES_PASSWORD;
    this.imessageAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT;
    
    if (!this.password) {
      console.error('❌ BLUEBUBBLES_PASSWORD not set');
    }
    
    this.client = axios.create({
      timeout: 30000
    });
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Raw URL from env: ${rawUrl}`);
    console.log(`   Cleaned URL: ${this.serverUrl}`);
    console.log(`   Password: ${this.password ? '***' : 'Not set'}`);
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
      
      const chatGuid = to.includes('@') ? to : this.formatPhoneNumber(to);
      const tempGuid = this.generateTempGuid();
      
      // Build URL without double slashes
      const endpoint = '/api/v1/message/text';
      const fullUrl = `${this.serverUrl}${endpoint}`;  // No trailing slash issue now
      const urlWithPassword = `${fullUrl}?password=${this.password}`;
      
      console.log(`\n📍 URL DEBUG:`);
      console.log(`   Server URL (cleaned): ${this.serverUrl}`);
      console.log(`   Endpoint: ${endpoint}`);
      console.log(`   Full URL: ${fullUrl}`);
      console.log(`   URL with password: ${urlWithPassword}`);
      
      const payload = {
        chatGuid: chatGuid,
        tempGuid: tempGuid,
        message: message
      };
      
     
      
      const response = await this.client.post(urlWithPassword, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`\n📥 RESPONSE: Status ${response.status}`);
      
      if (response.data && response.data.status === 200) {
        console.log(`   ✅ Message sent successfully!`);
        return {
          success: true,
          guid: response.data.data?.guid,
          messageId: response.data.data?.guid
        };
      } else {
        throw new Error(response.data?.message || 'Unknown error');
      }
      
    } catch (error) {
      console.error(`   ❌ Error:`, error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, error.response.data);
      }
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  async getStatus() {
    try {
      const pingUrl = `${this.serverUrl}/api/v1/ping?password=${this.password}`;
      const response = await this.client.get(pingUrl);
      return { success: true, status: response.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

export default BlueBubblesService;