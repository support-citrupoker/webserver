// services/ghl.service.js
import { HighLevel } from '@gohighlevel/api-client';

class GHLService {
  constructor() {
    // Initialize the SDK client with Private Integration Token
    this.client = new HighLevel({
      privateIntegrationToken: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
      apiVersion: process.env.GHL_API_VERSION || '2021-07-28'
    });
    
    // Store locationId from environment
    this.locationId = process.env.GHL_LOCATION_ID;
    
    // Suppress SDK internal error logging for expected errors
    this._suppressSDKLogging();
    
    console.log('🔧 GHL SDK Client initialized');
    console.log(`📍 Default locationId: ${this.locationId ? 'Set' : 'Not set'}`);
  }

  /**
   * Suppress SDK internal error logging for expected errors
   */
  _suppressSDKLogging() {
    // Store original console.error
    const originalError = console.error;
    
    // Override console.error to filter out expected duplicate errors
    console.error = (...args) => {
      const errorMsg = args.join(' ');
      // Filter out duplicate contact errors (these are expected)
      if (errorMsg.includes('duplicated contacts') || 
          errorMsg.includes('Conversation already exists')) {
        return; // Silently ignore
      }
      // Pass through other errors
      originalError.apply(console, args);
    };
  }

  /**
   * Set or update the location ID
   */
  setLocationId(locationId) {
    this.locationId = locationId;
    console.log(`📍 Location ID set to: ${locationId}`);
  }

  // ==================== CONTACT METHODS ====================

  /**
   * Search contacts by phone number
   */
  async searchContactsByPhone(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) {
        throw new Error('locationId is required');
      }

      console.log(`🔍 Searching contact with phone: ${phoneNumber}`);

      const cleanPhone = phoneNumber.replace(/\D/g, '');

      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        query: cleanPhone,
        pageLimit: 10,
        filters: [{
          field: "phone",
          operator: "contains",
          value: cleanPhone
        }]
      });

      const contacts = response.contacts || [];
      console.log(`✅ Found ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.debug('🔍 Search returned no results');
      return [];
    }
  }

  /**
   * Get contact by ID
   */
  async getContact(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      
      console.log(`👤 Fetching contact: ${contactId}`);
      
      const response = await this.client.contacts.getContact(
        { contactId },
        { headers: { locationId } }
      );
      
      return response.contact || response;
    } catch (error) {
      console.error('❌ Get contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create a new contact - WITH SILENT DUPLICATE HANDLING
   */
  async createContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const formattedPhone = this.formatPhoneForGHL(contactData.phone);

      const payload = {
        locationId: locationId,
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        name: contactData.name || `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim(),
        phone: formattedPhone,
        ...(contactData.email && contactData.email.trim() !== '' ? { email: contactData.email } : {}),
        address1: contactData.address1 || '',
        city: contactData.city || '',
        state: contactData.state || '',
        postalCode: contactData.postalCode || '',
        country: contactData.country || 'US',
        website: contactData.website || '',
        timezone: contactData.timezone || 'America/New_York',
        tags: contactData.tags || ['tallbob_contact'],
        source: contactData.source || 'Tall Bob Integration',
        customFields: contactData.customFields || []
      };

      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.contacts.createContact(payload);
      
      const contact = response.contact || response;
      return contact;
    } catch (error) {
      // SILENT HANDLING: Check if this is a duplicate contact error
      if (error.statusCode === 400 && 
          error.response?.message === 'This location does not allow duplicated contacts.' &&
          error.response?.meta?.contactId) {
        
        // Return the existing contact info without logging
        return {
          id: error.response.meta.contactId,
          name: error.response.meta.contactName,
          _exists: true,
          _matchingField: error.response.meta.matchingField
        };
      }
      
      // Only throw for real errors
      throw error;
    }
  }

  /**
   * Update an existing contact - FIXED: Clean data properly
   */
  async updateContact(contactId, contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`✏️ Updating contact: ${contactId}`);

      // Create a clean copy of the data WITHOUT any headers or locationId
      const cleanData = {};
      
      // Only copy valid contact fields
      if (contactData.firstName) cleanData.firstName = contactData.firstName;
      if (contactData.lastName) cleanData.lastName = contactData.lastName;
      if (contactData.name) cleanData.name = contactData.name;
      if (contactData.email && contactData.email.trim() !== '') cleanData.email = contactData.email;
      if (contactData.phone) cleanData.phone = contactData.phone;
      if (contactData.address1) cleanData.address1 = contactData.address1;
      if (contactData.city) cleanData.city = contactData.city;
      if (contactData.state) cleanData.state = contactData.state;
      if (contactData.postalCode) cleanData.postalCode = contactData.postalCode;
      if (contactData.country) cleanData.country = contactData.country;
      if (contactData.website) cleanData.website = contactData.website;
      if (contactData.timezone) cleanData.timezone = contactData.timezone;
      if (contactData.tags) cleanData.tags = contactData.tags;
      if (contactData.source) cleanData.source = contactData.source;
      if (contactData.customFields) cleanData.customFields = contactData.customFields;

      console.log('Update data:', JSON.stringify(cleanData, null, 2));

      const response = await this.client.contacts.updateContact(
        { contactId, ...cleanData },  // Body only - no headers
        { headers: { locationId } }    // Headers separately
      );

      console.log(`✅ Contact updated: ${contactId}`);
      return response.contact || response;
    } catch (error) {
      console.error('❌ Update contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create or update contact (upsert by phone) - WITH SILENT HANDLING
   */
  async upsertContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      // Try to create the contact - will silently return existing if duplicate
      const result = await this.createContact(contactData, locationId);
      
      // Check if this was an existing contact
      if (result._exists) {
        console.log(`📌 Updating existing contact: ${result.id}`);
        
        // Get the full contact details
        const existingContact = await this.getContact(result.id, locationId);
        
        // Prepare update data - merge new data with existing
        const updateData = {
          firstName: contactData.firstName || existingContact.firstName,
          lastName: contactData.lastName || existingContact.lastName,
          ...(contactData.email && contactData.email.trim() !== '' ? { email: contactData.email } : {}),
          tags: [
            ...(existingContact.tags || []),
            ...(contactData.tags || [])
          ].filter((v, i, a) => a.indexOf(v) === i),
          ...(contactData.source ? { source: contactData.source } : {}),
          customFields: [
            ...(existingContact.customFields || []),
            ...(contactData.customFields || [])
          ]
        };

        const updated = await this.updateContact(result.id, updateData, locationId);
        return { contact: updated, action: 'updated' };
      }
      
      // New contact created
      return { contact: result, action: 'created' };
      
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw error;
    }
  }

  /**
   * Check if a phone number exists - SILENT AND CLEAN
   */
  async phoneExists(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      // Try to create a minimal contact with just the phone number
      const testContact = {
        phone: phoneNumber,
        firstName: 'Temp',
        lastName: 'Temp',
        tags: ['temp_check']
      };

      const result = await this.createContact(testContact, locationId);
      
      // If we get an existing contact back
      if (result._exists) {
        return {
          exists: true,
          contactId: result.id,
          contactName: result.name,
          matchingField: result._matchingField
        };
      }
      
      // Phone doesn't exist and we created a temp contact
      return { exists: false };
      
    } catch (error) {
      return { exists: false, error: error.message };
    }
  }

  /**
   * Get contact by phone number
   */
  async getContactByPhone(phoneNumber, locationId = this.locationId) {
    try {
      const result = await this.phoneExists(phoneNumber, locationId);
      
      if (result.exists && result.contactId) {
        const contact = await this.getContact(result.contactId, locationId);
        return contact;
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Delete a contact
   */
  async deleteContact(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🗑️ Deleting contact: ${contactId}`);

      const response = await this.client.contacts.deleteContact(
        { contactId },
        { headers: { locationId } }
      );

      console.log(`✅ Contact deleted: ${contactId}`);
      return response;
    } catch (error) {
      console.error('❌ Delete contact failed:', error.message);
      throw error;
    }
  }

  // ==================== TAG METHODS ====================

  /**
   * Add tag to contact
   */
  async addTagToContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.addTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove tag from contact
   */
  async removeTagFromContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.removeTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== CUSTOM FIELD METHODS ====================

  /**
   * Update custom field for contact
   */
  async updateCustomField(contactId, fieldKey, fieldValue, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.updateCustomFields(
        { 
          contactId,
          customFields: [{ key: fieldKey, value: fieldValue }]
        },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== NOTE METHODS ====================

  /**
   * Add note to contact
   */
  async addNote(contactId, note, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.addNote(
        { contactId, body: note },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get notes for contact
   */
  async getNotes(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.getNotes(
        { contactId },
        { headers: { locationId } }
      );

      return response.notes || [];
    } catch (error) {
      return [];
    }
  }

  // ==================== CONVERSATION METHODS ====================

  /**
   * Create a conversation - WITH SILENT DUPLICATE HANDLING
   */
  async createConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.conversations.createConversation({
        contactId,
        locationId,
        type
      });

      const conversation = response.conversation || response;
      return conversation;
    } catch (error) {
      // SILENT HANDLING: Conversation already exists
      if (error.statusCode === 400 && 
          error.response?.message === 'Conversation already exists' &&
          error.response?.conversationId) {
        
        return {
          id: error.response.conversationId,
          _exists: true
        };
      }
      
      throw error;
    }
  }

  /**
   * Get or create conversation
   */
  async getOrCreateConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      const conversation = await this.createConversation(contactId, type, locationId);
      
      return {
        conversation,
        action: conversation._exists ? 'existing' : 'created'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Add message to conversation
   */
  async addMessageToConversation(conversationId, messageData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!messageData.contactId) throw new Error('contactId is required');

      const messageType = messageData.messageType || 'SMS';
      
      const payload = {
        type: messageType,
        contactId: messageData.contactId,
        message: messageData.body,
        attachments: messageData.mediaUrls || [],
        status: messageData.direction === 'outbound' ? 'delivered' : 'pending',
        ...(messageType === 'SMS' && {
          fromNumber: messageData.fromNumber,
          toNumber: messageData.toNumber
        })
      };

      // Remove undefined fields
      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.conversations.sendANewMessage(payload);

      return {
        id: response.messageId,
        conversationId: response.conversationId,
        emailMessageId: response.emailMessageId,
        messageIds: response.messageIds,
        msg: response.msg
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get conversation messages
   */
  async getConversationMessages(conversationId, locationId = this.locationId, limit = 50) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.conversations.getMessages(
        conversationId,
        { limit },
        { headers: { locationId } }
      );

      return response.messages || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Check if a conversation exists
   */
  async conversationExists(contactId, locationId = this.locationId) {
    try {
      const result = await this.createConversation(contactId, 'SMS', locationId);
      
      return {
        exists: !!result._exists,
        conversationId: result._exists ? result.id : null
      };
    } catch (error) {
      return { exists: false, error: error.message };
    }
  }

  // ==================== LOCATION METHODS ====================

  /**
   * Get location details
   */
  async getLocation(locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.locations.getLocation(
        { locationId },
        { preferredTokenType: 'location' }
      );

      return response.location || response;
    } catch (error) {
      throw error;
    }
  }

  // ==================== HELPER METHODS ====================

  /**
   * Format phone number for GHL (E.164 format with +)
   */
  formatPhoneForGHL(phone) {
    if (!phone) return phone;
    const cleaned = phone.replace(/\D/g, '');
    return `+${cleaned}`;
  }

  /**
   * Test connection
   */
  async testConnection(locationId = this.locationId) {
    try {
      if (!locationId) {
        return {
          success: false,
          error: 'No locationId provided'
        };
      }

      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        pageLimit: 1
      });

      return {
        success: true,
        message: 'GHL connection successful',
        hasContacts: (response.contacts?.length || 0) > 0
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