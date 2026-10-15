import { z } from 'zod';

export const addressSchema = z.object({
  name: z.string().trim().min(3, 'Name fehlt'),
  company: z.string().trim().max(100).optional().default(''),
  address1: z.string().trim().min(3, 'Straße fehlt'),
  address2: z.string().trim().max(100).optional().default(''),
  zip: z.string().trim().min(4, 'PLZ fehlt'),
  city: z.string().trim().min(2, 'Ort fehlt'),
  countryCode: z.string().trim().length(2).transform((s) => s.toUpperCase()).default('DE'),
  phone: z.string().trim().max(40).optional().default(''),
}).superRefine((a, ctx) => {
  if (a.countryCode === 'DE' && !/^\d{5}$/.test(a.zip)) ctx.addIssue({ code: 'custom', path: ['zip'], message: 'PLZ muss 5-stellig sein' });
});

export const orderSchema = z.object({
  reference: z.string().trim().min(1, 'Bestellnummer fehlt').max(64).regex(/^[\w.\-/#]+$/, 'Bestellnummer: nur Buchstaben, Ziffern, . - _ / #'),
  shippingAddress: addressSchema,
  lines: z.array(z.object({
    sku: z.string().trim().min(1),
    quantity: z.coerce.number().int().min(1).max(100),
  })).min(1, 'Keine Positionen').max(50),
  note: z.string().trim().max(500).optional().default(''),
});

export type OrderPayload = z.infer<typeof orderSchema>;

export const formatIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'bestellung'}: ${i.message}`);
