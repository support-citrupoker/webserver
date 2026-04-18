// services/bluebubbles.service.js
import axios from 'axios';
import { randomUUID } from 'crypto';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

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
      console.log(`\n📱 ===== BLUEBUBBLES SEND TEXT DEBUG =====`);
      console.log(`   Original "to" value: ${to}`);
      console.log(`   Original message: ${message}`);
      
      const chatGuid = to.includes('@') ? to : this.formatPhoneNumber(to);
      const tempGuid = this.generateTempGuid();
      
      const endpoint = '/api/v1/message/text';
      const fullUrl = `${this.serverUrl}${endpoint}`;
      const urlWithPassword = `${fullUrl}?password=${this.password}`;
      
      console.log(`\n📍 URL DEBUG:`);
      console.log(`   Server URL (cleaned): ${this.serverUrl}`);
      console.log(`   Endpoint: ${endpoint}`);
      console.log(`   Full URL: ${fullUrl}`);
      
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
        console.log(`   ✅ Text message sent successfully!`);
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

  // FIXED: Download image from URL and send as multipart attachment
  async sendAttachment({ to, message, attachmentUrl, effectId = null }) {
    try {
      console.log(`\n📱 ===== BLUEBUBBLES SEND ATTACHMENT DEBUG =====`);
      console.log(`   Original "to" value: ${to}`);
      console.log(`   Original message: ${message}`);
      console.log(`   Attachment URL: ${attachmentUrl}`);
      
      const chatGuid = to.includes('@') ? to : this.formatPhoneNumber(to);
      const tempGuid = this.generateTempGuid();
      
      // Build URL for attachment endpoint
      const endpoint = '/api/v1/message/attachment';
      const fullUrl = `${this.serverUrl}${endpoint}`;
      const urlWithPassword = `${fullUrl}?password=${this.password}`;
      
      console.log(`\n📍 URL DEBUG:`);
      console.log(`   Server URL (cleaned): ${this.serverUrl}`);
      console.log(`   Endpoint: ${endpoint}`);
      console.log(`   Full URL: ${fullUrl}`);
      
      // First, download the image from the URL
      console.log(`   📥 Downloading image from URL...`);
      const imageResponse = await axios.get(attachmentUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      
      // Get file extension from URL or content-type
      let fileExtension = 'png';
      const contentType = imageResponse.headers['content-type'];
      if (contentType) {
        if (contentType.includes('jpeg') || contentType.includes('jpg')) fileExtension = 'jpg';
        else if (contentType.includes('png')) fileExtension = 'png';
        else if (contentType.includes('gif')) fileExtension = 'gif';
        else if (contentType.includes('webp')) fileExtension = 'webp';
      }
      
      const fileName = `attachment_${Date.now()}.${fileExtension}`;
      console.log(`   📁 File name: ${fileName}`);
      
      // Create form data
      const formData = new FormData();
      formData.append('chatGuid', chatGuid);
      formData.append('tempGuid', tempGuid);
      formData.append('message', message || '📸 Image');
      if (effectId) formData.append('effectId', effectId);
      
      // Append the downloaded image as buffer
      formData.append('attachment', Buffer.from(imageResponse.data), {
        filename: fileName,
        contentType: contentType || 'image/png'
      });
      
      const response = await this.client.post(urlWithPassword, formData, {
        headers: {
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      
      console.log(`\n📥 RESPONSE: Status ${response.status}`);
      
      if (response.data && response.data.status === 200) {
        console.log(`   ✅ Attachment sent successfully!`);
        return {
          success: true,
          guid: response.data.data?.guid,
          messageId: response.data.data?.guid
        };
      } else {
        throw new Error(response.data?.message || 'Unknown error');
      }
      
    } catch (error) {
      console.error(`   ❌ Attachment error:`, error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, error.response.data);
      }
      throw new Error(`Failed to send iMessage attachment: ${error.message}`);
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