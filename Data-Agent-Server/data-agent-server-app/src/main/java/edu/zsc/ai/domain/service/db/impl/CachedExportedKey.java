package edu.zsc.ai.domain.service.db.impl;

import java.util.List;

/** Foreign key that points at a table. Shared by SQL completion and ER query focus so they share one cache entry. */
public record CachedExportedKey(
        String catalog,
        String schema,
        String table,
        String name,
        List<String> columns,
        List<String> referencedColumns
) {
}
