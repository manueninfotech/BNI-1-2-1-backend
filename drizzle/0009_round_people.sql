ALTER TABLE "conclaves" ADD COLUMN "round_people" jsonb;--> statement-breakpoint
-- Backfill from existing schedules: per round, the larger of persons_per_table
-- and the round's biggest table (members + captain), at most 8.
UPDATE "conclaves" AS c
SET "round_people" = sub.arr
FROM (
  SELECT id, jsonb_agg(size ORDER BY rn) AS arr
  FROM (
    SELECT c2.id,
           (r->>'roundNumber')::int AS rn,
           LEAST(8, GREATEST(COALESCE(c2.persons_per_table, 1),
             MAX(jsonb_array_length(COALESCE(t->'memberIds', '[]'::jsonb))
                 + CASE WHEN t->'captainId' IS NULL OR t->'captainId' = 'null'::jsonb THEN 0 ELSE 1 END))) AS size
    FROM "conclaves" c2,
         jsonb_array_elements(c2.schedule->'rounds') AS r,
         jsonb_array_elements(r->'tables') AS t
    WHERE jsonb_typeof(c2.schedule->'rounds') = 'array'
    GROUP BY c2.id, rn, c2.persons_per_table
  ) x
  GROUP BY id
) sub
WHERE c.id = sub.id;
