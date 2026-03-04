// services/ghl.service.js
import axios from 'axios';

class GHLService {
  constructor() {
    this.baseURL = 'https://services.leadconnectorhq.com';
    this.apiVersion = process.env.GHL_API_VERSION || '2021-07-28';
    this.accessToken = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
    this.locationId = process.env.GHL_LOCATION_ID; // Get from env
    
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Version': this.apiVersion,
        'Accept': 'application/json'
      }
    });

    console.log('🔧 GHL Client initialized');
  }

  // ==================== CONTACT METHODS ====================

  async searchContactsByPhone(phoneNumber) {
    try {
      if (!this.locationId) {
        throw new Error('locationId not set. Set GHL_LOCATION_ID in .env');
      }
      
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      const searchPayload = {
        locationId: this.locationId,
        filters: [{
          field: "phone",
          operator: "contains", 
          value: cleanPhone
        }],
        pageLimit: 10
      };

      const response = await this.client.post('/contacts/search', searchPayload);
      return response.data.contacts || [];
    } catch (error) {
      console.error('❌ Search failed:', error.message);
      return [];
    }
  }

  async createContact(contactData) {
    try {
      if (!this.locationId) {
        throw new Error('locationId not set');
      }

      const payload = {
        locationId: this.locationId,
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        email: contactData.email || '',
        phone: `+${contactData.phone.replace(/\D/g, '')}`,
        tags: contactData.tags || ['tallbob_contact'],
        source: contactData.source || 'Tall Bob Integration',
        ...contactData
      };

      const response = await this.client.post('/contacts/', payload);
      return response.data.contact || response.data;
    } catch (error) {
      console.error('❌ Create contact failed:', error.message);
      throw error;
    }
  }

  async upsertContact(contactData) {
    try {
      const existing = await this.searchContactsByPhone(contactData.phone);
      
      if (existing && existing.length > 0) {
        // Update existing
        const response = await this.client.put(`/contacts/${existing[0].id}`, {
          ...contactData,
          locationId: this.locationId
        });
        return { contact: response.data.contact || response.data, action: 'updated' };
      } else {
        // Create new
        const created = await this.createContact(contactData);
        return { contact: created, action: 'created' };
      }
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw error;
    }
  }

  async addTagToContact(contactId, tag) {
    try {
      const response = await this.client.post(`/contacts/${contactId}/tags`, {
        tag,
        locationId: this.locationId
      });
      return response.data;
    } catch (error) {
      console.error('❌ Add tag failed:', error.message);
      return { success: false };
    }
  }

  // ==================== CONVERSATION METHODS ====================

  async createConversation(contactId, type = 'SMS') {
    try {
      const response = await this.client.post('/conversations/', {
        contactId,
        locationId: this.locationId,
        type
      });
      return response.data.conversation || response.data;
    } catch (error) {
      console.error('❌ Create conversation failed:', error.message);
      throw error;
    }
  }

  async addMessageToConversation(conversationId, messageData) {
    try {
      const payload = {
        body: messageData.body,
        messageType: messageData.messageType || 'SMS',
        direction: messageData.direction || 'inbound',
        attachments: messageData.mediaUrls || [],
        date: messageData.date || new Date().toISOString()
      };

      const response = await this.client.post(`/conversations/${conversationId}/messages`, payload);
      return response.data.message || response.data;
    } catch (error) {
      console.error('❌ Add message failed:', error.message);
      throw error;
    }
  }

  // ==================== HELPER METHODS ====================

  setLocationId(locationId) {
    this.locationId = locationId;
    console.log(`📍 Location ID set: ${locationId}`);
  }

  formatPhoneForGHL(phone) {
    return `+${phone.replace(/\D/g, '')}`;
  }
}

export default GHLService;