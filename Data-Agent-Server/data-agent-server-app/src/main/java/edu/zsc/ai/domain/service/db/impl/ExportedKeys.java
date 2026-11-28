package edu.zsc.ai.domain.service.db.impl;

import edu.zsc.ai.domain.model.context.DbContext;
import java.sql.Connection;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SortedMap;
import java.util.TreeMap;
import lombok.extern.slf4j.Slf4j;

@Slf4j
public final class ExportedKeys {

    private ExportedKeys() {
    }

    public static List<CachedExportedKey> load(Connection connection, DbContext source, String table) {
        record Key(String catalog, String schema, String table, String name) {
        }
        Map<Key, SortedMap<Integer, String[]>> groups = new LinkedHashMap<>();
        try (ResultSet rs = connection.getMetaData().getExportedKeys(source.catalog(), source.schema(), table)) {
            while (rs.next()) {
                String constraint = rs.getString("FK_NAME");
                if (constraint == null) {
                    continue;
                }
                Key key = new Key(rs.getString("FKTABLE_CAT"), rs.getString("FKTABLE_SCHEM"), rs.getString("FKTABLE_NAME"), constraint);
                groups.computeIfAbsent(key, ignored -> new TreeMap<>()).put(rs.getInt("KEY_SEQ"),
                        new String[]{rs.getString("FKCOLUMN_NAME"), rs.getString("PKCOLUMN_NAME")});
            }
        } catch (Exception e) {
            log.debug("Exported foreign keys unavailable for {}: {}", table, e.getMessage());
        }
        List<CachedExportedKey> keys = new ArrayList<>();
        for (Map.Entry<Key, SortedMap<Integer, String[]>> entry : groups.entrySet()) {
            keys.add(new CachedExportedKey(
                    entry.getKey().catalog(),
                    entry.getKey().schema(),
                    entry.getKey().table(),
                    entry.getKey().name(),
                    entry.getValue().values().stream().map(pair -> pair[0]).toList(),
                    entry.getValue().values().stream().map(pair -> pair[1]).toList()));
        }
        return keys;
    }
}
