package edu.zsc.ai.domain.service.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import edu.zsc.ai.api.model.request.ErQueryFocus;
import edu.zsc.ai.domain.service.db.impl.CachedExportedKey;
import edu.zsc.ai.plugin.model.metadata.ColumnMetadata;
import edu.zsc.ai.plugin.model.metadata.ConstraintMetadata;
import java.util.List;
import org.junit.jupiter.api.Test;

class ErQueryFocusResolverTest {

    @Test
    void verifiesTablesAndSplitsOneHopFromCachedMetadata() {
        ErQueryFocusMetadata metadata = new ErQueryFocusMetadata() {
            @Override
            public List<String> tableNames(Long connectionId, String catalog, String schema) {
                return List.of("orders");
            }

            @Override
            public List<ColumnMetadata> columns(Long connectionId, String catalog, String schema, String table) {
                return List.of(new ColumnMetadata("id", 4, "int", 11, 0, false, 1, "", true, true, false, null));
            }

            @Override
            public List<ConstraintMetadata> foreignKeys(Long connectionId, String catalog, String schema, String table) {
                return List.of(new ConstraintMetadata(
                        "fk_address", "orders", "FOREIGN KEY", List.of("address_id"),
                        "public", "address", List.of("id"), null, true));
            }

            @Override
            public List<CachedExportedKey> referencingKeys(Long connectionId, String catalog, String schema, String table) {
                return List.of();
            }
        };

        ErQueryFocus request = new ErQueryFocus();
        request.setConnectionId(7L);
        request.setConnectionName("shop-db");
        request.setCatalogName("shop");
        request.setSchemaName("public");
        ErQueryFocus.Table orders = new ErQueryFocus.Table();
        orders.setName("Orders");
        ErQueryFocus.Table missing = new ErQueryFocus.Table();
        missing.setName("missing");
        request.setTables(List.of(orders, missing));

        ErQueryFocus resolved = new ErQueryFocusResolver(metadata).resolve(request);

        assertEquals(List.of("orders"), resolved.getTables().stream().map(ErQueryFocus.Table::getName).toList());
        assertEquals("id", resolved.getTables().get(0).getColumns().get(0).getName());
        assertTrue(resolved.getTables().get(0).getColumns().get(0).isPrimaryKey());
        assertTrue(resolved.getInsideRelations().isEmpty());
        assertEquals(1, resolved.getOutsideRelations().size());
        assertEquals("address", resolved.getOutsideRelations().get(0).getToTable());
        assertEquals("shop", resolved.getOutsideRelations().get(0).getToCatalog());
        assertEquals("public", resolved.getOutsideRelations().get(0).getToSchema());
    }
}
