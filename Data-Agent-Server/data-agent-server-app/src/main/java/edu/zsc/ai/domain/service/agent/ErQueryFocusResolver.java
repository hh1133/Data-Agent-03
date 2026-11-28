package edu.zsc.ai.domain.service.agent;

import edu.zsc.ai.api.model.request.ErQueryFocus;
import edu.zsc.ai.domain.service.db.impl.CachedExportedKey;
import edu.zsc.ai.plugin.model.metadata.ColumnMetadata;
import edu.zsc.ai.plugin.model.metadata.ConstraintMetadata;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.apache.commons.lang3.StringUtils;
import org.springframework.stereotype.Service;

/**
 * Verifies circled tables against cached metadata and resolves foreign keys
 * inside the selection plus one hop outward.
 */
@Service
@RequiredArgsConstructor
public class ErQueryFocusResolver {

    private final ErQueryFocusMetadata metadata;

    public ErQueryFocus resolve(ErQueryFocus focus) {
        if (focus == null || focus.getTables() == null || focus.getTables().isEmpty() || focus.getConnectionId() == null) {
            return focus;
        }
        Map<String, ErQueryFocus.Table> verified = new LinkedHashMap<>();
        List<ErQueryFocus.Relation> seenRelations = new ArrayList<>();
        Set<String> relationKeys = new LinkedHashSet<>();
        for (Map.Entry<Scope, List<String>> group : groups(focus).entrySet()) {
            Scope scope = group.getKey();
            Map<String, String> canonical = canonicalNames(metadata.tableNames(
                    focus.getConnectionId(), scope.catalog(), scope.schema()));
            for (String requestedName : group.getValue()) {
                String real = canonical.get(norm(requestedName));
                if (real == null) {
                    continue;
                }
                List<ColumnMetadata> columns = metadata.columns(
                        focus.getConnectionId(), scope.catalog(), scope.schema(), real);
                ErQueryFocus.Table table = copyTable(scope.catalog(), scope.schema(), real, columns);
                verified.putIfAbsent(key(table.getCatalog(), table.getSchema(), table.getName()), table);
                addRelations(focus.getConnectionId(), scope, real, seenRelations, relationKeys);
            }
        }

        List<ErQueryFocus.Table> ordered = new ArrayList<>();
        Set<String> selected = new LinkedHashSet<>();
        for (ErQueryFocus.Table requested : focus.getTables()) {
            if (requested == null || StringUtils.isBlank(requested.getName())) {
                continue;
            }
            String catalog = firstNonBlank(requested.getCatalog(), focus.getCatalogName());
            String schema = firstNonBlank(requested.getSchema(), focus.getSchemaName());
            ErQueryFocus.Table found = verified.get(key(catalog, schema, requested.getName()));
            if (found == null) {
                continue;
            }
            String id = key(found.getCatalog(), found.getSchema(), found.getName());
            if (selected.add(id)) {
                ordered.add(found);
            }
        }

        List<ErQueryFocus.Relation> inside = new ArrayList<>();
        List<ErQueryFocus.Relation> outside = new ArrayList<>();
        for (ErQueryFocus.Relation relation : seenRelations) {
            boolean fromIn = selected.contains(key(relation.getFromCatalog(), relation.getFromSchema(), relation.getFromTable()));
            boolean toIn = selected.contains(key(relation.getToCatalog(), relation.getToSchema(), relation.getToTable()));
            if (fromIn && toIn) {
                inside.add(relation);
            } else if (fromIn || toIn) {
                outside.add(relation);
            }
        }

        ErQueryFocus resolved = new ErQueryFocus();
        resolved.setConnectionId(focus.getConnectionId());
        resolved.setConnectionName(focus.getConnectionName());
        resolved.setCatalogName(focus.getCatalogName());
        resolved.setSchemaName(focus.getSchemaName());
        resolved.setTables(ordered);
        resolved.setInsideRelations(inside);
        resolved.setOutsideRelations(outside);
        return resolved;
    }

    private static Map<Scope, List<String>> groups(ErQueryFocus focus) {
        Map<Scope, List<String>> groups = new LinkedHashMap<>();
        for (ErQueryFocus.Table table : focus.getTables()) {
            if (table == null || StringUtils.isBlank(table.getName())) {
                continue;
            }
            Scope scope = new Scope(
                    firstNonBlank(table.getCatalog(), focus.getCatalogName()),
                    firstNonBlank(table.getSchema(), focus.getSchemaName()));
            groups.computeIfAbsent(scope, ignored -> new ArrayList<>()).add(table.getName());
        }
        return groups;
    }

    private void addRelations(Long connectionId, Scope scope, String table,
                               List<ErQueryFocus.Relation> relations, Set<String> relationKeys) {
        for (ConstraintMetadata constraint : metadata.foreignKeys(connectionId, scope.catalog(), scope.schema(), table)) {
            if (constraint == null || StringUtils.isBlank(constraint.referencedTable())
                    || constraint.columns() == null || constraint.referencedColumns() == null
                    || constraint.columns().isEmpty()
                    || constraint.columns().size() != constraint.referencedColumns().size()) {
                continue;
            }
            addRelation(relations, relationKeys,
                    scope.catalog(), scope.schema(), table, constraint.columns(),
                    scope.catalog(), firstNonBlank(constraint.referencedSchema(), scope.schema()),
                    constraint.referencedTable(), constraint.referencedColumns());
        }
        for (CachedExportedKey inbound : metadata.referencingKeys(connectionId, scope.catalog(), scope.schema(), table)) {
            if (inbound == null || StringUtils.isBlank(inbound.table())
                    || inbound.columns() == null || inbound.referencedColumns() == null
                    || inbound.columns().isEmpty()
                    || inbound.columns().size() != inbound.referencedColumns().size()) {
                continue;
            }
            addRelation(relations, relationKeys,
                    firstNonBlank(inbound.catalog(), scope.catalog()),
                    firstNonBlank(inbound.schema(), scope.schema()),
                    inbound.table(), inbound.columns(),
                    scope.catalog(), scope.schema(), table, inbound.referencedColumns());
        }
    }

    private static void addRelation(List<ErQueryFocus.Relation> relations, Set<String> relationKeys,
                                    String fromCatalog, String fromSchema, String fromTable, List<String> fromColumns,
                                    String toCatalog, String toSchema, String toTable, List<String> toColumns) {
        ErQueryFocus.Relation relation = new ErQueryFocus.Relation();
        relation.setFromCatalog(fromCatalog);
        relation.setFromSchema(fromSchema);
        relation.setFromTable(fromTable);
        relation.setFromColumns(fromColumns);
        relation.setToCatalog(toCatalog);
        relation.setToSchema(toSchema);
        relation.setToTable(toTable);
        relation.setToColumns(toColumns);
        if (relationKeys.add(relationKey(relation))) {
            relations.add(relation);
        }
    }

    private static Map<String, String> canonicalNames(List<String> names) {
        Map<String, String> canonical = new LinkedHashMap<>();
        if (names == null) {
            return canonical;
        }
        for (String name : names) {
            if (StringUtils.isNotBlank(name)) {
                canonical.putIfAbsent(norm(name), name.trim());
            }
        }
        return canonical;
    }

    private static ErQueryFocus.Table copyTable(String catalog, String schema, String name, List<ColumnMetadata> columns) {
        ErQueryFocus.Table table = new ErQueryFocus.Table();
        table.setName(name);
        table.setCatalog(catalog);
        table.setSchema(schema);
        List<ErQueryFocus.Column> copied = new ArrayList<>();
        if (columns != null) {
            for (ColumnMetadata column : columns) {
                if (column == null || StringUtils.isBlank(column.name())) {
                    continue;
                }
                ErQueryFocus.Column field = new ErQueryFocus.Column();
                field.setName(column.name());
                field.setTypeName(column.typeName());
                field.setPrimaryKey(column.isPrimaryKeyPart());
                copied.add(field);
            }
        }
        table.setColumns(copied);
        return table;
    }

    private static String relationKey(ErQueryFocus.Relation relation) {
        return key(relation.getFromCatalog(), relation.getFromSchema(), relation.getFromTable())
                + "|" + String.join(",", relation.getFromColumns())
                + "->" + key(relation.getToCatalog(), relation.getToSchema(), relation.getToTable())
                + "|" + String.join(",", relation.getToColumns())
                + "|" + key(relation.getViaCatalog(), relation.getViaSchema(), relation.getViaTable());
    }

    private static String key(String catalog, String schema, String table) {
        return norm(catalog) + "\n" + norm(schema) + "\n" + norm(table);
    }

    private static String norm(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }

    private static String firstNonBlank(String preferred, String fallback) {
        return StringUtils.firstNonBlank(preferred, fallback);
    }

    private record Scope(String catalog, String schema) {
    }
}
