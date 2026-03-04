// services/ghl.service.js
import axios from 'axios';

class GHLService {
  constructor() {
    this.baseURL = 'https://services.leadconnectorhq.com';
    this.apiVersion = process.env.GHL_API_VERSION || '2021-07-28';
    this.accessToken = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
    
    // Create axios instance with default headers
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Version': this.apiVersion,
        'Accept': 'application/json'
      }
    });

    // Add response interceptor for debugging
    this.client.interceptors.response.use(
      response => {
        console.log(`📥 GHL Response: ${response.status} ${response.config.method} ${response.config.url}`);
        return response;
      },
      error => {
        console.error('❌ GHL API Error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          config: {
            method: error.config?.method,
            url: error.config?.url,
            data: error.config?.data
          }
        });
        return Promise.reject(error);
      }
    );

    console.log('🔧 GHL Client initialized with axios');
  }

  // ==================== LOCATIONS ====================
  
  /**
   * Get all locations
   * GET /locations/
   */
  async getLocations() {
    try {
      console.log('📍 Fetching locations...');
      
      const response = await this.client.get('/locations/');
      
      // Extract locations from response
      const locations = response.data.locations || response.data;
      console.log(`✅ Found ${locations?.length || 0} locations`);
      return locations;
    } catch (error) {
      console.error('❌ Failed to get locations:', error.message);
      throw new Error(`Failed to get locations: ${error.message}`);
    }
  }

  // ==================== CONTACTS ====================

  /**
   * Search contacts by phone number
   * POST /contacts/search
   */
  async searchContactsByPhone(phoneNumber, locationId) {
    try {
      console.log(`🔍 Searching contact with phone: ${phoneNumber}`);
      
      // Clean the phone number - remove any non-numeric characters except +
      const cleanPhone = phoneNumber.replace(/[^\d+]/g, '');
      
      const searchPayload = {
        locationId: locationId,
        filters: [{
          field: "phone",
          operator: "contains",
          value: cleanPhone
        }],
        pageLimit: 10,
        options: {
          includeStats: false
        }
      };

      console.log('Search payload:', JSON.stringify(searchPayload, null, 2));

      const response = await this.client.post('/contacts/search', searchPayload);
      
      // Extract contacts from response
      const contacts = response.data.contacts || [];
      console.log(`✅ Found ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.error('❌ Search failed:', error.message);
      if (error.response?.data) {
        console.error('Error details:', error.response.data);
      }
      return []; // Return empty array on error
    }
  }

  /**
   * Get contact by ID
   * GET /contacts/{contactId}
   */
  async getContact(contactId, locationId) {
    try {
      console.log(`👤 Fetching contact: ${contactId}`);
      
      const response = await this.client.get(`/contacts/${contactId}`, {
        params: { locationId }
      });
      
      return response.data.contact || response.data;
    } catch (error) {
      console.error('❌ Get contact failed:', error.message);
      throw new Error(`Failed to get contact: ${error.message}`);
    }
  }

  /**
   * Create a new contact
   * POST /contacts/
   * Based on API documentation: https://marketplace.gohighlevel.com/docs/ghl/contacts/create-contact
   */
  async createContact(contactData, locationId) {
    try {
      console.log(`👤 Creating new contact: ${contactData.phone || contactData.email || 'unknown'}`);
      
      // Build the complete contact payload based on the API docs
      const payload = {
        // Required: locationId must be included
        locationId: locationId,
        
        // Basic info
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        name: contactData.name || `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim(),
        email: contactData.email || '',
        phone: this.formatPhoneForGHL(contactData.phone),
        
        // Address fields
        address1: contactData.address1 || '',
        city: contactData.city || '',
        state: contactData.state || '',
        postalCode: contactData.postalCode || '',
        country: contactData.country || 'US',
        
        // Optional fields
        gender: contactData.gender || '',
        website: contactData.website || '',
        timezone: contactData.timezone || 'America/New_York',
        dateOfBirth: contactData.dateOfBirth || '',
        companyName: contactData.companyName || '',
        source: contactData.source || 'Tall Bob Integration',
        assignedTo: contactData.assignedTo || '',
        
        // Do Not Disturb settings
        dnd: contactData.dnd || false,
        dndSettings: contactData.dndSettings || {
          "Call": { "status": "active" },
          "Email": { "status": "active" },
          "SMS": { "status": "active" },
          "WhatsApp": { "status": "active" }
        },
        
        // Tags array
        tags: contactData.tags || ['tallbob_contact'],
        
        // Custom fields array
        customFields: contactData.customFields || []
      };

      // Remove undefined fields to keep payload clean
      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      console.log('Contact payload:', JSON.stringify(payload, null, 2));

      const response = await this.client.post('/contacts/', payload);
      
      const contact = response.data.contact || response.data;
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
    } catch (error) {
      console.error('❌ Create contact failed:', error.message);
      if (error.response?.data) {
        console.error('Error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(`Failed to create contact: ${error.message}`);
    }
  }

  /**
   * Update an existing contact
   * PUT /contacts/{contactId}
   */
  async updateContact(contactId, contactData, locationId) {
    try {
      console.log(`✏️ Updating contact: ${contactId}`);
      
      const payload = {
        ...contactData,
        locationId
      };

      const response = await this.client.put(`/contacts/${contactId}`, payload);
      
      const contact = response.data.contact || response.data;
      console.log(`✅ Contact updated: ${contactId}`);
      return contact;
    } catch (error) {
      console.error('❌ Update contact failed:', error.message);
      throw new Error(`Failed to update contact: ${error.message}`);
    }
  }

  /**
   * Create or update contact (upsert by phone)
   */
  async upsertContact(contactData, locationId) {
    try {
      // Ensure phone is formatted properly for search
      const searchPhone = this.formatPhoneForGHL(contactData.phone);
      
      // First try to find existing contact
      const existingContacts = await this.searchContactsByPhone(searchPhone, locationId);
      
      if (existingContacts && existingContacts.length > 0) {
        // Update existing contact
        const existingContact = existingContacts[0];
        console.log(`Found existing contact: ${existingContact.id}`);
        
        // Merge existing data with new data
        const updateData = {
          ...contactData,
          // Preserve existing tags and add new ones (remove duplicates)
          tags: [
            ...(existingContact.tags || []),
            ...(contactData.tags || [])
          ].filter((v, i, a) => a.indexOf(v) === i),
          // Merge custom fields (you might want more sophisticated logic here)
          customFields: [
            ...(existingContact.customFields || []),
            ...(contactData.customFields || [])
          ]
        };
        
        const updated = await this.updateContact(existingContact.id, updateData, locationId);
        return { contact: updated, action: 'updated' };
      } else {
        // Create new contact
        const created = await this.createContact(contactData, locationId);
        return { contact: created, action: 'created' };
      }
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw new Error(`Failed to upsert contact: ${error.message}`);
    }
  }

  /**
   * Delete a contact
   * DELETE /contacts/{contactId}
   */
  async deleteContact(contactId, locationId) {
    try {
      console.log(`🗑️ Deleting contact: ${contactId}`);
      
      const response = await this.client.delete(`/contacts/${contactId}`, {
        params: { locationId }
      });
      
      console.log(`✅ Contact deleted: ${contactId}`);
      return response.data;
    } catch (error) {
      console.error('❌ Delete contact failed:', error.message);
      throw new Error(`Failed to delete contact: ${error.message}`);
    }
  }

  // ==================== TAGS ====================

  /**
   * Add tag to contact
   * POST /contacts/{contactId}/tags
   */
  async addTagToContact(contactId, tag, locationId) {
    try {
      console.log(`🏷️ Adding tag "${tag}" to contact: ${contactId}`);
      
      const response = await this.client.post(`/contacts/${contactId}/tags`, {
        tag,
        locationId
      });
      
      console.log(`✅ Tag added: ${tag}`);
      return response.data;
    } catch (error) {
      console.error('❌ Add tag failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove tag from contact
   * DELETE /contacts/{contactId}/tags/{tag}
   */
  async removeTagFromContact(contactId, tag, locationId) {
    try {
      console.log(`🏷️ Removing tag "${tag}" from contact: ${contactId}`);
      
      const response = await this.client.delete(`/contacts/${contactId}/tags/${tag}`, {
        params: { locationId }
      });
      
      console.log(`✅ Tag removed: ${tag}`);
      return response.data;
    } catch (error) {
      console.error('❌ Remove tag failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== CUSTOM FIELDS ====================

  /**
   * Update custom field for contact
   * PUT /contacts/{contactId}/customFields
   */
  async updateCustomField(contactId, fieldKey, fieldValue, locationId) {
    try {
      console.log(`📋 Updating custom field ${fieldKey} for contact: ${contactId}`);
      
      const response = await this.client.put(`/contacts/${contactId}/customFields`, {
        customFields: [{ key: fieldKey, value: fieldValue }],
        locationId
      });
      
      console.log(`✅ Custom field updated: ${fieldKey}=${fieldValue}`);
      return response.data;
    } catch (error) {
      console.error('❌ Update custom field failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== NOTES ====================

  /**
   * Add note to contact
   * POST /contacts/{contactId}/notes
   */
  async addNote(contactId, note, locationId) {
    try {
      console.log(`📝 Adding note to contact: ${contactId}`);
      
      const response = await this.client.post(`/contacts/${contactId}/notes`, {
        body: note,
        locationId
      });
      
      console.log(`✅ Note added`);
      return response.data;
    } catch (error) {
      console.error('❌ Add note failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get notes for contact
   * GET /contacts/{contactId}/notes
   */
  async getNotes(contactId, locationId) {
    try {
      console.log(`📋 Fetching notes for contact: ${contactId}`);
      
      const response = await this.client.get(`/contacts/${contactId}/notes`, {
        params: { locationId }
      });
      
      return response.data.notes || [];
    } catch (error) {
      console.error('❌ Get notes failed:', error.message);
      return [];
    }
  }

  // ==================== CONVERSATIONS ====================

  /**
   * Create a conversation
   * POST /conversations/
   */
  async createConversation({ contactId, locationId, type = 'SMS' }) {
    try {
      console.log(`💬 Creating conversation for contact: ${contactId}`);
      
      const response = await this.client.post('/conversations/', {
        contactId,
        locationId,
        type
      });
      
      const conversation = response.data.conversation || response.data;
      console.log(`✅ Conversation created: ${conversation.id}`);
      return conversation;
    } catch (error) {
      console.error('❌ Create conversation failed:', error.message);
      throw new Error(`Failed to create conversation: ${error.message}`);
    }
  }

  /**
   * Get conversation by ID
   * GET /conversations/{conversationId}
   */
  async getConversation(conversationId, locationId) {
    try {
      console.log(`💬 Fetching conversation: ${conversationId}`);
      
      const response = await this.client.get(`/conversations/${conversationId}`, {
        params: { locationId }
      });
      
      return response.data;
    } catch (error) {
      console.error('❌ Get conversation failed:', error.message);
      throw new Error(`Failed to get conversation: ${error.message}`);
    }
  }

  /**
   * Add message to conversation
   * POST /conversations/{conversationId}/messages
   */
  async addMessageToConversation(conversationId, messageData) {
    try {
      console.log(`📝 Adding message to conversation: ${conversationId}`);
      
      const payload = {
        body: messageData.body,
        messageType: messageData.messageType || 'SMS',
        direction: messageData.direction || 'inbound',
        attachments: messageData.mediaUrls || [],
        date: messageData.date || new Date().toISOString(),
        providerMessageId: messageData.providerMessageId
      };

      const response = await this.client.post(`/conversations/${conversationId}/messages`, payload);
      
      const message = response.data.message || response.data;
      console.log(`✅ Message added: ${message.id}`);
      return message;
    } catch (error) {
      console.error('❌ Add message failed:', error.message);
      throw new Error(`Failed to add message: ${error.message}`);
    }
  }

  /**
   * Get messages from conversation
   * GET /conversations/{conversationId}/messages
   */
  async getConversationMessages(conversationId, locationId, limit = 50) {
    try {
      console.log(`📋 Fetching messages for conversation: ${conversationId}`);
      
      const response = await this.client.get(`/conversations/${conversationId}/messages`, {
        params: { locationId, limit }
      });
      
      return response.data.messages || [];
    } catch (error) {
      console.error('❌ Get messages failed:', error.message);
      return [];
    }
  }

  // ==================== HELPER METHODS ====================

  /**
   * Extract locations from various response formats
   */
  _extractLocations(response) {
    if (!response) return [];
    if (Array.isArray(response)) return response;
    if (response.locations && Array.isArray(response.locations)) return response.locations;
    if (response.data && Array.isArray(response.data)) return response.data;
    return [];
  }

  /**
   * Format phone number for GHL (ensure + prefix)
   */
  formatPhoneForGHL(phone) {
    if (!phone) return phone;
    // Remove any non-numeric characters
    const cleaned = phone.replace(/\D/g, '');
    // Ensure it has + prefix
    return `+${cleaned}`;
  }

  /**
   * Test connection to GHL API
   */
  async testConnection() {
    try {
      const locations = await this.getLocations();
      return {
        success: true,
        message: 'GHL connection successful',
        locationCount: locations?.length || 0
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export default GHLService;