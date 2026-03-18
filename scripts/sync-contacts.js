// scripts/sync-contacts.js
import 'dotenv/config';
import { HighLevel } from '@gohighlevel/api-client';
import CommentTracker from '../services/tracker.service.js';

async function syncContacts() {
  console.log('\n🔄 Syncing contacts from GHL...');
  
  const tracker = new CommentTracker();
  await tracker.initialize();

  const ghlClient = new HighLevel({
    privateIntegrationToken: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
    apiVersion: process.env.GHL_API_VERSION || '2021-07-28'
  });

  let page = 1;
  const pageSize = 100;
  let hasMore = true;
  let totalAdded = 0;

  while (hasMore) {
    const response = await ghlClient.contacts.searchContactsAdvanced({
      locationId: process.env.GHL_LOCATION_ID,
      pageLimit: pageSize,
      page: page
    });

    const contacts = response.contacts || [];
    
    for (const contact of contacts) {
      if (contact.phone) {  // Only track contacts with phone numbers
        await tracker.addContact(contact.id, contact.phone);
        totalAdded++;
      }
    }

    console.log(`📦 Page ${page}: Processed ${contacts.length} contacts`);
    
    hasMore = contacts.length === pageSize;
    page++;
    
    if (hasMore) await new Promise(r => setTimeout(r, 500));
  }

  const count = await tracker.getCount();
  console.log(`✅ Sync complete! Tracking ${count} contacts with phone numbers`);
  
  await tracker.close();
}

syncContacts().catch(console.error);