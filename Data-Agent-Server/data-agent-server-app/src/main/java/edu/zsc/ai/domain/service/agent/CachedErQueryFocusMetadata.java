package edu.zsc.ai.domain.service.agent;

import edu.zsc.ai.domain.model.context.DbContext;
import edu.zsc.ai.domain.service.db.ConnectionService;
import edu.zsc.ai.domain.service.db.impl.ActiveConnectionRegistry;
import edu.zsc.ai.domain.service.db.impl.ActiveConnectionRegistry.ActiveConnection;
import edu.zsc.ai.domain.service.db.impl.CachedExportedKey;
import edu.zsc.ai.domain.service.db.impl.ExportedKeys;
import edu.zsc.ai.domain.service.db.impl.SqlCompletionMetadataCache;
import edu.zsc.ai.plugin.capability.SqlCompleter;
import edu.zsc.ai.plugin.manager.DefaultPluginManager;
import edu.zsc.ai.plugin.model.metadata.ColumnMetadata;
import edu.zsc.ai.plugin.model.metadata.ConstraintMetadata;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class CachedErQueryFocusMetadata implements ErQueryFocusMetadata {

    private final ConnectionService connectionService;
    private final SqlCompletionMetadataCache cache;

    @Override
    public List<String> tableNames(Long connectionId, String catalog, String schema) {
        return load(connectionId, catalog, schema, "tables", null, (plugin, source, connection) ->
                DefaultPluginManager.getInstance().getTableManagerByPluginId(plugin)
                        .getTableNames(connection, source.catalog(), source.schema()));
    }

    @Override
    public List<ColumnMetadata> columns(Long connectionId, String catalog, String schema, String table) {
        return load(connectionId, catalog, schema, "columns", table, (plugin, source, connection) ->
                DefaultPluginManager.getInstance().getColumnManagerByPluginId(plugin)
                        .getColumns(connection, source.catalog(), source.schema(), table));
    }

    @Override
    public List<ConstraintMetadata> foreignKeys(Long connectionId, String catalog, String schema, String table) {
        return load(connectionId, catalog, schema, "constraints", table, (plugin, source, connection) ->
                DefaultPluginManager.getInstance().getConstraintManagerByPluginId(plugin)
                        .getConstraints(connection, source.catalog(), source.schema(), table));
    }

    @Override
    public List<CachedExportedKey> referencingKeys(Long connectionId, String catalog, String schema, String table) {
        return load(connectionId, catalog, schema, "exportedKeys", table, (plugin, source, connection) ->
                ExportedKeys.load(connection, source, table));
    }

    private <T> List<T> load(Long connectionId, String catalog, String schema, String kind, String object, Loader<T> loader) {
        DbContext requested = new DbContext(connectionId, catalog, schema);
        connectionService.openConnection(requested);
        ActiveConnection active = ActiveConnectionRegistry.getOwnedConnection(requested);
        DbContext source = source(active, requested);
        return cache.get(active.pluginId(), source, kind, object, active.dataSource(), () -> {
            try (var borrowed = active.borrowConnection()) {
                return loader.load(active.pluginId(), source, borrowed.connection());
            }
        });
    }

    private static DbContext source(ActiveConnection active, DbContext requested) {
        try (var borrowed = active.borrowConnection()) {
            SqlCompleter completer = DefaultPluginManager.getInstance().getSqlCompleterByPluginId(active.pluginId());
            String schema = completer == null
                    ? requested.schema()
                    : completer.completionSchema(borrowed.connection(), requested.schema());
            return new DbContext(requested.connectionId(), requested.catalog(), schema);
        }
    }

    @FunctionalInterface
    private interface Loader<T> {
        List<T> load(String plugin, DbContext source, java.sql.Connection connection);
    }
}
