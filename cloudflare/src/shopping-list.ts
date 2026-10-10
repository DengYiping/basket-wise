import { z } from "zod";
import { idSchema, operationSchema, quantitySchema } from "../../src/domain.js";

// No price/currency: a profile-wide intention can be used in any of its trips.
export const shoppingListItemInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  quantity: quantitySchema.default(1),
  unit: z.enum(["each", "kg", "litre"]).default("each"),
  notes: z.string().trim().max(500).default(""),
});
export type ShoppingListItem = z.infer<typeof shoppingListItemInput> & {
  id: string;
};
export const shoppingListActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("get_shopping_list") }),
  shoppingListItemInput.extend({
    kind: z.literal("add_shopping_list_item"),
    operationId: operationSchema,
  }),
  z.strictObject({
    kind: z.literal("update_shopping_list_item"),
    operationId: operationSchema,
    itemId: idSchema,
    patch: shoppingListItemInput
      .partial()
      .refine((patch) => Object.keys(patch).length > 0),
  }),
  z.strictObject({
    kind: z.literal("remove_shopping_list_item"),
    operationId: operationSchema,
    itemId: idSchema,
  }),
]);
export type ShoppingListAction = z.infer<typeof shoppingListActionSchema>;
export interface ShoppingListSnapshot {
  spaceId: string;
  shoppingListRevision: number;
  shoppingList: ShoppingListItem[];
  profileExpiresAt: number;
  alreadyApplied: boolean;
  itemId?: string;
}
