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
    const originalError = console.error;
    console.error = (...args) => {
      const errorMsg = args.join(' ');
      if (errorMsg.includes('duplicated contacts') || 
          errorMsg.includes('Conversation already exists')) {
        return;
      }
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
   * Search contacts by phone number - IMPROVED with multiple search strategies
   */
  async searchContactsByPhone(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) {
        throw new Error('locationId is required');
      }

      console.log(`🔍 Searching contact with phone: ${phoneNumber}`);

      // Clean the phone number - remove all non-numeric characters
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      // Strategy 1: Try advanced search with filters
      try {
        const response = await this.client.contacts.searchContactsAdvanced({
          locationId: locationId,
          pageLimit: 10,
          filters: [{
            field: "phone",
            operator: "contains",
            value: cleanPhone
          }]
        });

        if (response.contacts && response.contacts.length > 0) {
          console.log(`✅ Found ${response.contacts.length} contacts via search`);
          return response.contacts;
        }
      } catch (e) {
        // Fall through to next strategy
      }

      // Strategy 2: Try with query parameter
      try {
        const response = await this.client.contacts.searchContactsAdvanced({
          locationId: locationId,
          query: cleanPhone,
          pageLimit: 10
        });

        if (response.contacts && response.contacts.length > 0) {
          console.log(`✅ Found ${response.contacts.length} contacts via query`);
          return response.contacts;
        }
      } catch (e) {
        // Fall through to next strategy
      }

      console.log('🔍 No contacts found via search');
      return [];
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
      // SILENT HANDLING: Duplicate contact error - this is how we detect existing contacts
      if (error.statusCode === 400 && 
          error.response?.message === 'This location does not allow duplicated contacts.' &&
          error.response?.meta?.contactId) {
        
        return {
          id: error.response.meta.contactId,
          name: error.response.meta.contactName,
          _exists: true,
          _matchingField: error.response.meta.matchingField
        };
      }
      throw error;
    }
  }

  /**
   * Update an existing contact - COMPLETELY ISOLATED FROM HEADERS
   */
  async updateContact(contactId, contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`✏️ Updating contact: ${contactId}`);

      // Create a pristine object with only allowed fields
      const cleanData = {};
      
      // Allowed fields for contact update
      const allowedFields = [
        'firstName', 'lastName', 'name', 'email', 'phone',
        'address1', 'city', 'state', 'postalCode', 'country',
        'website', 'timezone', 'tags', 'source', 'customFields'
      ];

      // Only copy allowed fields if they exist and have values
      allowedFields.forEach(field => {
        if (contactData[field] !== undefined && contactData[field] !== null) {
          // Handle empty strings for email specially
          if (field === 'email' && contactData[field] === '') {
            return;
          }
          
          // Deep clone arrays and objects to avoid reference issues
          if (Array.isArray(contactData[field])) {
            cleanData[field] = JSON.parse(JSON.stringify(contactData[field]));
          } else if (typeof contactData[field] === 'object' && contactData[field] !== null) {
            cleanData[field] = JSON.parse(JSON.stringify(contactData[field]));
          } else {
            cleanData[field] = contactData[field];
          }
        }
      });

      // Explicitly remove any potential headers or locationId that might have snuck in
      delete cleanData.headers;
      delete cleanData.locationId;

      console.log('Clean update data:', JSON.stringify(cleanData, null, 2));

      // Only proceed if there's actual data to update
      if (Object.keys(cleanData).length === 0) {
        console.log('⚠️ No data to update');
        return await this.getContact(contactId, locationId);
      }

      const response = await this.client.contacts.updateContact(
        { contactId, ...cleanData },  // Data goes in the first parameter
        { headers: { locationId } }    // Headers go in the second parameter
      );

      console.log(`✅ Contact updated: ${contactId}`);
      return response.contact || response;
    } catch (error) {
      console.error('❌ Update contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create or update contact (upsert by phone) - USING DUPLICATE ERRORS
   */
  async upsertContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🔄 Upserting contact with phone: ${contactData.phone}`);

      // Try to create the contact - will return existing contact info if duplicate
      const result = await this.createContact(contactData, locationId);
      
      // Check if this was an existing contact
      if (result._exists) {
        console.log(`📌 Found existing contact via duplicate error: ${result.id}`);
        
        // Get the full contact details
        const existingContact = await this.getContact(result.id, locationId);
        
        // Prepare update data - merge new data with existing
        const updateData = {
          firstName: contactData.firstName || existingContact.firstName,
          lastName: contactData.lastName || existingContact.lastName,
          email: contactData.email || existingContact.email,
          tags: [
            ...(existingContact.tags || []),
            ...(contactData.tags || [])
          ].filter((v, i, a) => a.indexOf(v) === i),
          source: contactData.source || existingContact.source,
          customFields: [
            ...(existingContact.customFields || []),
            ...(contactData.customFields || [])
          ]
        };

        // SAFETY: Remove any potential headers property
        delete updateData.headers;
        delete updateData.locationId;

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
   * Check if a phone number exists - USING DUPLICATE ERROR (MOST RELIABLE)
   */
  async phoneExists(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      // Try to create a minimal contact - will trigger duplicate error if exists
      const testContact = {
        phone: phoneNumber,
        firstName: 'Temp',
        lastName: 'Temp',
        tags: ['temp_check']
      };

      const result = await this.createContact(testContact, locationId);
      
      if (result._exists) {
        return {
          exists: true,
          contactId: result.id,
          contactName: result.name,
          matchingField: result._matchingField,
          method: 'duplicate_detection'
        };
      }
      
      return { exists: false, method: 'duplicate_detection' };
      
    } catch (error) {
      return { exists: false, error: error.message };
    }
  }

  /**
   * Get contact by phone number - USING DUPLICATE ERROR (MOST RELIABLE)
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

      return response.conversation || response;
    } catch (error) {
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

      const payload = {
        type: messageData.messageType || 'SMS',
        contactId: messageData.contactId,
        message: messageData.body,
        attachments: messageData.mediaUrls || [],
        status: messageData.direction === 'outbound' ? 'delivered' : 'pending',
        ...(messageData.messageType === 'SMS' && {
          fromNumber: messageData.fromNumber,
          toNumber: messageData.toNumber
        })
      };

      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.conversations.sendANewMessage(payload);

      return {
        id: response.messageId,
        conversationId: response.conversationId
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
      return { exists: false };
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
        return { success: false, error: 'No locationId provided' };
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
      return { success: false, error: error.message };
    }
  }
}

export default GHLService;