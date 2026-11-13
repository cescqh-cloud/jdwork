import type { SQL } from 'bun'
import { searchTerms } from './contract'

export interface Match {
  matched_terms: string[]
  lexical_score: number
}

export async function lexicalSearch<Row>(database: SQL, permitted: SQL.Query<unknown>, query: string, limit: number) {
  const { fts, terms } = searchTerms(query)
  if (!fts && !terms.length) return []
  return await database<(Row & Match)[]>`
    WITH permitted AS MATERIALIZED (${permitted}), query_terms AS (
      SELECT CASE WHEN ${fts}::text <> '' THEN plainto_tsquery('simple', ${fts}::text) END AS fts
    ), matched AS (
      SELECT p.*,
        ARRAY(SELECT term FROM unnest(${database.array(terms, 'TEXT')}) AS t(term)
          WHERE strpos(lower(normalize(p.searchable, NFKC)), term) > 0) AS matched_terms,
        CASE WHEN q.fts IS NOT NULL THEN ts_rank_cd(to_tsvector('simple', normalize(p.searchable, NFKC)), q.fts) ELSE 0 END AS fts_score
      FROM permitted p CROSS JOIN query_terms q
    )
    SELECT *, fts_score + cardinality(matched_terms) AS lexical_score FROM matched
    WHERE fts_score > 0 OR cardinality(matched_terms) > 0
    ORDER BY lexical_score DESC, updated_at DESC, id LIMIT ${limit}
  `
}
