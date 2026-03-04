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
    
    console.log('🔧 GHL SDK Client initialized');
    console.log(`📍 Default locationId: ${this.locationId ? 'Set' : 'Not set'}`);
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
      console.error('❌ Search failed:', error.message);
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
   * Create a new contact
   */
  async createContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`👤 Creating new contact: ${contactData.phone || 'unknown'}`);

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
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
    } catch (error) {
      console.error('❌ Create contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Update an existing contact
   */
  async updateContact(contactId, contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`✏️ Updating contact: ${contactId}`);

      const cleanData = { ...contactData };
      
      if (cleanData.email === '') {
        delete cleanData.email;
      }

      const response = await this.client.contacts.updateContact(
        { contactId, ...cleanData },
        { headers: { locationId } }
      );

      console.log(`✅ Contact updated: ${contactId}`);
      return response.contact || response;
    } catch (error) {
      console.error('❌ Update contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create or update contact (upsert by phone)
   * Uses duplicate error detection to find existing contacts
   */
  async upsertContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🔄 Upserting contact with phone: ${contactData.phone}`);

      // First try to create the contact
      try {
        const created = await this.createContact(contactData, locationId);
        return { contact: created, action: 'created' };
      } catch (error) {
        // Check if this is a duplicate contact error
        if (error.statusCode === 400 && 
            error.response?.message === 'This location does not allow duplicated contacts.' &&
            error.response?.meta?.contactId) {
          
          // Extract the existing contact ID from the error
          const existingContactId = error.response.meta.contactId;
          console.log(`📌 Found existing contact: ${existingContactId} (Phone already exists)`);
          
          // Get the full contact details
          const existingContact = await this.getContact(existingContactId, locationId);
          
          // Prepare update data - merge new data with existing
          const updateData = {
            firstName: contactData.firstName || existingContact.firstName,
            lastName: contactData.lastName || existingContact.lastName,
            // Only include email if provided and valid
            ...(contactData.email && contactData.email.trim() !== '' ? { email: contactData.email } : {}),
            // Merge tags (avoid duplicates)
            tags: [
              ...(existingContact.tags || []),
              ...(contactData.tags || [])
            ].filter((v, i, a) => a.indexOf(v) === i),
            // Include source if provided
            ...(contactData.source ? { source: contactData.source } : {}),
            // Merge custom fields
            customFields: [
              ...(existingContact.customFields || []),
              ...(contactData.customFields || [])
            ]
          };

          // Update the existing contact
          const updated = await this.updateContact(existingContactId, updateData, locationId);
          return { contact: updated, action: 'updated' };
        }
        
        // If it's a different error, rethrow
        throw error;
      }
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw error;
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

  /**
   * Check if a phone number exists using duplicate error detection
   */
  async phoneExists(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📞 Checking if phone exists: ${phoneNumber}`);

      // Try to create a minimal contact with just the phone number
      const testContact = {
        phone: phoneNumber,
        firstName: 'Temp',
        lastName: 'Temp',
        tags: ['temp_check']
      };

      try {
        await this.createContact(testContact, locationId);
        // If creation succeeds, phone doesn't exist
        console.log(`✅ Phone ${phoneNumber} does not exist`);
        return { exists: false };
      } catch (error) {
        // Check if this is a duplicate contact error
        if (error.statusCode === 400 && 
            error.response?.message === 'This location does not allow duplicated contacts.' &&
            error.response?.meta?.contactId) {
          
          console.log(`✅ Phone ${phoneNumber} exists (Contact ID: ${error.response.meta.contactId})`);
          return {
            exists: true,
            contactId: error.response.meta.contactId,
            contactName: error.response.meta.contactName,
            matchingField: error.response.meta.matchingField
          };
        }
        
        // If it's a different error, rethrow
        throw error;
      }
    } catch (error) {
      console.error('❌ Phone check failed:', error.message);
      return { exists: false, error: error.message };
    }
  }

  /**
   * Get contact by phone number using duplicate error detection
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
      console.error('❌ Get contact by phone failed:', error.message);
      return null;
    }
  }

  // ==================== TAG METHODS ====================

  /**
   * Add tag to contact
   */
  async addTagToContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🏷️ Adding tag "${tag}" to contact: ${contactId}`);

      const response = await this.client.contacts.addTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      console.log(`✅ Tag added: ${tag}`);
      return response;
    } catch (error) {
      console.error('❌ Add tag failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove tag from contact
   */
  async removeTagFromContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🏷️ Removing tag "${tag}" from contact: ${contactId}`);

      const response = await this.client.contacts.removeTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      console.log(`✅ Tag removed: ${tag}`);
      return response;
    } catch (error) {
      console.error('❌ Remove tag failed:', error.message);
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

      console.log(`📋 Updating custom field ${fieldKey} for contact: ${contactId}`);

      const response = await this.client.contacts.updateCustomFields(
        { 
          contactId,
          customFields: [{ key: fieldKey, value: fieldValue }]
        },
        { headers: { locationId } }
      );

      console.log(`✅ Custom field updated`);
      return response;
    } catch (error) {
      console.error('❌ Update custom field failed:', error.message);
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

      console.log(`📝 Adding note to contact: ${contactId}`);

      const response = await this.client.contacts.addNote(
        { contactId, body: note },
        { headers: { locationId } }
      );

      console.log(`✅ Note added`);
      return response;
    } catch (error) {
      console.error('❌ Add note failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get notes for contact
   */
  async getNotes(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📋 Fetching notes for contact: ${contactId}`);

      const response = await this.client.contacts.getNotes(
        { contactId },
        { headers: { locationId } }
      );

      return response.notes || [];
    } catch (error) {
      console.error('❌ Get notes failed:', error.message);
      return [];
    }
  }

  // ==================== CONVERSATION METHODS ====================

  /**
   * Create a conversation
   */
  async createConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`💬 Creating conversation for contact: ${contactId}`);

      const response = await this.client.conversations.createConversation({
        contactId,
        locationId,
        type
      });

      const conversation = response.conversation || response;
      console.log(`✅ Conversation created: ${conversation.id}`);
      return conversation;
    } catch (error) {
      console.error('❌ Create conversation failed:', error.message);
      throw error;
    }
  }

  /**
   * Get or create conversation (handles "already exists" error)
   */
  async getOrCreateConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`💬 Getting or creating conversation for contact: ${contactId}`);

      try {
        const conversation = await this.createConversation(contactId, type, locationId);
        return { conversation, action: 'created' };
      } catch (error) {
        if (error.statusCode === 400 && 
            error.response?.message === 'Conversation already exists' &&
            error.response?.conversationId) {
          
          const existingConversationId = error.response.conversationId;
          console.log(`📌 Using existing conversation: ${existingConversationId}`);
          
          return { 
            conversation: { id: existingConversationId }, 
            action: 'existing' 
          };
        }
        throw error;
      }
    } catch (error) {
      console.error('❌ Get or create conversation failed:', error.message);
      throw error;
    }
  }

  /**
   * Add message to conversation
   * Uses: conversations.sendANewMessage()
   * Docs: https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message
   */
  async addMessageToConversation(conversationId, messageData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!messageData.contactId) throw new Error('contactId is required for sending messages');

      console.log(`📝 Adding message to conversation: ${conversationId}`);

      // Determine message type based on content
      const messageType = messageData.messageType || 'SMS';
      
      // Build the payload according to the API docs
      const payload = {
        type: messageType,
        contactId: messageData.contactId,
        message: messageData.body,
        attachments: messageData.mediaUrls || [],
        status: messageData.direction === 'outbound' ? 'delivered' : 'pending',
        ...(messageType === 'SMS' && {
          fromNumber: messageData.fromNumber,
          toNumber: messageData.toNumber
        }),
        ...(messageType === 'Email' && {
          subject: messageData.subject,
          html: messageData.html,
          emailFrom: messageData.emailFrom,
          emailTo: messageData.emailTo,
          emailCc: messageData.emailCc,
          emailBcc: messageData.emailBcc
        }),
        ...(messageData.replyMessageId && {
          replyMessageId: messageData.replyMessageId
        }),
        ...(messageData.templateId && {
          templateId: messageData.templateId
        }),
        ...(messageData.scheduledTimestamp && {
          scheduledTimestamp: messageData.scheduledTimestamp
        }),
        ...(messageType === 'InternalComment' && {
          mentions: messageData.mentions || [],
          userId: messageData.userId
        })
      };

      // Remove undefined fields
      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      console.log('Message payload:', JSON.stringify(payload, null, 2));

      // Use the SDK's sendANewMessage method
      const response = await this.client.conversations.sendANewMessage(payload);

      console.log(`✅ Message added: ${response.messageId}`);
      return {
        id: response.messageId,
        conversationId: response.conversationId,
        emailMessageId: response.emailMessageId,
        messageIds: response.messageIds,
        msg: response.msg
      };
    } catch (error) {
      console.error('❌ Add message failed:', error.message);
      if (error.response?.data) {
        console.error('Error details:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Get conversation messages
   */
  async getConversationMessages(conversationId, locationId = this.locationId, limit = 50) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📋 Fetching messages for conversation: ${conversationId}`);

      const response = await this.client.conversations.getMessages(
        conversationId,
        { limit },
        { headers: { locationId } }
      );

      return response.messages || [];
    } catch (error) {
      console.error('❌ Get messages failed:', error.message);
      return [];
    }
  }

  /**
   * Check if a conversation exists for a contact
   */
  async conversationExists(contactId, locationId = this.locationId) {
    try {
      try {
        await this.createConversation(contactId, 'SMS', locationId);
        return { exists: false };
      } catch (error) {
        if (error.statusCode === 400 && 
            error.response?.message === 'Conversation already exists' &&
            error.response?.conversationId) {
          return { 
            exists: true, 
            conversationId: error.response.conversationId 
          };
        }
        throw error;
      }
    } catch (error) {
      console.error('❌ Conversation check failed:', error.message);
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

      console.log(`📍 Fetching location: ${locationId}`);

      const response = await this.client.locations.getLocation(
        { locationId },
        { preferredTokenType: 'location' }
      );

      return response.location || response;
    } catch (error) {
      console.error('❌ Get location failed:', error.message);
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
          error: 'No locationId provided. Set GHL_LOCATION_ID in .env'
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