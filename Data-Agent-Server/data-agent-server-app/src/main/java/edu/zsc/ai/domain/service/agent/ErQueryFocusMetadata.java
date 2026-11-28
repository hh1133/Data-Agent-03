package edu.zsc.ai.domain.service.agent;

import edu.zsc.ai.domain.service.db.impl.CachedExportedKey;
import edu.zsc.ai.plugin.model.metadata.ColumnMetadata;
import edu.zsc.ai.plugin.model.metadata.ConstraintMetadata;
import java.util.List;

/** Metadata the ER query focus reads. A cache hit must not query the database again. */
public interface ErQueryFocusMetadata {

    List<String> tableNames(Long connectionId, String catalog, String schema);

    List<ColumnMetadata> columns(Long connectionId, String catalog, String schema, String table);

    List<ConstraintMetadata> foreignKeys(Long connectionId, String catalog, String schema, String table);

    List<CachedExportedKey> referencingKeys(Long connectionId, String catalog, String schema, String table);
}
