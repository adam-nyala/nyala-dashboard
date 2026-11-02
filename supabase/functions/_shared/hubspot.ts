// Shared HubSpot helpers for the Nyala Labs integration layer.
// Secret required: HUBSPOT_TOKEN (a HubSpot private-app access token with
// crm.objects.companies.read/write and crm.objects.contacts.read scopes).

export const HUBSPOT_API = "https://api.hubapi.com";

export function hubspotToken(): string {
  const t = Deno.env.get("HUBSPOT_TOKEN");
  if (!t) throw new Error("HUBSPOT_TOKEN secret is not set in Supabase (Edge Functions > Secrets).");
  return t;
}

export async function hs(path: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${HUBSPOT_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${hubspotToken()}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (r.status === 429) { // rate limited: back off and retry
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      continue;
    }
    const text = await r.text();
    const body = text ? JSON.parse(text) : {};
    if (!r.ok) {
      const msg = body?.message || body?.error || `HubSpot ${r.status}`;
      const err = new Error(msg) as Error & { status?: number; category?: string };
      err.status = r.status;
      err.category = body?.category;
      throw err;
    }
    return body;
  }
  throw new Error("HubSpot rate limit: retries exhausted");
}

// Company property -> hubspot_companies column. Standard HubSpot properties
// work out of the box; the rest are custom company properties Nyala can
// create in HubSpot (Settings > Properties > Company) with these internal
// names. Any property that doesn't exist in HubSpot is simply left blank.
export const COMPANY_PROPS: Record<string, string> = {
  name: "name",
  dba: "dba",
  website: "website",
  phone: "phone",
  address: "address_line1",
  city: "city",
  state: "state",
  zip: "zip",
  partner_type: "partner_type",
  account_status: "account_status",
  msa_status: "msa_status",
  msa_signed_date: "msa_signed_date",
  buyer_msa_signed_date: "buyer_msa_signed_date",
  pub_msa_signed_date: "pub_msa_signed_date",
  tax_form_status: "tax_form_status",
  onboarding_status: "onboarding_status",
  payment_terms: "payment_terms",
  publisher_payment_terms: "publisher_payment_terms",
  payment_method: "payment_method",
  traffic_type: "traffic_type",
  call_types: "call_types",
  billing_contact_name: "billing_contact_name",
  billing_contact_email: "billing_contact_email",
  billing_contact_phone: "billing_contact_phone",
  operations_contact_name: "operations_contact_name",
  operations_contact_email: "operations_contact_email",
  operations_contact_phone: "operations_contact_phone",
  createdate: "created_time",
  hs_lastmodifieddate: "modified_time",
};

export const CONTACT_PROPS = ["firstname", "lastname", "email", "phone", "mobilephone", "jobtitle", "createdate"];

// The HubSpot company property the dashboard writes when a client is
// toggled active/inactive (and reads back on sync).
export const STATUS_PROP = "account_status";
