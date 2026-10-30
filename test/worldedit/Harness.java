import com.sk89q.jnbt.CompoundTag;
import com.sk89q.jnbt.NBTInputStream;
import com.sk89q.jnbt.NamedTag;
import com.sk89q.jnbt.Tag;
import com.sk89q.worldedit.BlockVector;
import com.sk89q.worldedit.Vector;
import com.sk89q.worldedit.blocks.BaseBlock;
import com.sk89q.worldedit.entity.Entity;
import com.sk89q.worldedit.extent.clipboard.Clipboard;
import com.sk89q.worldedit.extent.clipboard.io.ClipboardFormat;
import com.sk89q.worldedit.extent.clipboard.io.ClipboardReader;
import com.sk89q.worldedit.util.Location;
import com.sk89q.worldedit.world.registry.LegacyWorldData;
import java.io.BufferedInputStream;
import java.io.FileInputStream;
import java.util.Map;
import java.util.zip.GZIPInputStream;

// Loads files with the real WorldEdit 1.8 reader, exactly as //schem load does, and prints what
// it sees so the test suite can compare. "--nbt" only parses the NBT, for maps too big to hold
// as WorldEdit's per-block objects.
public class Harness {
    public static void main(String[] args) throws Exception {
        boolean nbtOnly = args[0].equals("--nbt");
        for (int i = nbtOnly ? 1 : 0; i < args.length; i++) {
            if (nbtOnly) readNbt(args[i]);
            else readClipboard(args[i]);
        }
    }

    private static String quote(String text) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32 || c > 126) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    private static String json(Object value) {
        if (value instanceof Tag) return json(((Tag) value).getValue());
        if (value instanceof String) return quote((String) value);
        if (value instanceof Number) return value.toString();
        if (value instanceof Map) {
            StringBuilder out = new StringBuilder("{");
            boolean first = true;
            for (Object entry : ((Map<?, ?>) value).entrySet()) {
                Map.Entry<?, ?> pair = (Map.Entry<?, ?>) entry;
                if (!first) out.append(',');
                first = false;
                out.append(quote(String.valueOf(pair.getKey()))).append(':').append(json(pair.getValue()));
            }
            return out.append('}').toString();
        }
        if (value instanceof Iterable) {
            StringBuilder out = new StringBuilder("[");
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                out.append(json(item));
            }
            return out.append(']').toString();
        }
        return "null";
    }

    private static void readClipboard(String path) throws Exception {
        try (FileInputStream file = new FileInputStream(path);
             BufferedInputStream buffered = new BufferedInputStream(file)) {
            ClipboardReader reader = ClipboardFormat.SCHEMATIC.getReader(buffered);
            Clipboard clipboard = reader.read(LegacyWorldData.getInstance());
            Vector min = clipboard.getMinimumPoint();
            Vector max = clipboard.getMaximumPoint();
            Vector origin = clipboard.getOrigin();
            int width = max.getBlockX() - min.getBlockX() + 1;
            int height = max.getBlockY() - min.getBlockY() + 1;
            int length = max.getBlockZ() - min.getBlockZ() + 1;

            int hash = 0;
            long nonAir = 0;
            StringBuilder tiles = new StringBuilder();
            for (int y = 0; y < height; y++) {
                for (int z = 0; z < length; z++) {
                    for (int x = 0; x < width; x++) {
                        BaseBlock block = clipboard.getBlock(new Vector(min.getBlockX() + x, min.getBlockY() + y, min.getBlockZ() + z));
                        hash = hash * 31 + ((block.getType() << 4) | block.getData());
                        if (block.getType() != 0) nonAir++;
                        CompoundTag nbt = block.getNbtData();
                        if (nbt != null) {
                            if (tiles.length() > 0) tiles.append(',');
                            tiles.append("{\"type\":").append(block.getType())
                                .append(",\"data\":").append(block.getData())
                                .append(",\"nbt\":").append(json(nbt)).append('}');
                        }
                    }
                }
            }

            StringBuilder entities = new StringBuilder();
            for (Entity entity : clipboard.getEntities()) {
                Location location = entity.getLocation();
                if (entities.length() > 0) entities.append(',');
                entities.append("{\"id\":").append(quote(entity.getState().getTypeId()))
                    .append(",\"pos\":[").append(location.getX()).append(',').append(location.getY()).append(',').append(location.getZ()).append("]")
                    .append(",\"nbt\":").append(json(entity.getState().getNbtData())).append('}');
            }

            System.out.println("{\"file\":" + quote(path)
                + ",\"size\":[" + width + "," + height + "," + length + "]"
                + ",\"min\":[" + min.getBlockX() + "," + min.getBlockY() + "," + min.getBlockZ() + "]"
                + ",\"origin\":[" + origin.getBlockX() + "," + origin.getBlockY() + "," + origin.getBlockZ() + "]"
                + ",\"hash\":" + hash
                + ",\"nonAir\":" + nonAir
                + ",\"tiles\":[" + tiles + "]"
                + ",\"entities\":[" + entities + "]}");
        }
    }

    @SuppressWarnings("unchecked")
    private static void readNbt(String path) throws Exception {
        try (FileInputStream file = new FileInputStream(path);
             NBTInputStream input = new NBTInputStream(new GZIPInputStream(new BufferedInputStream(file, 1 << 20)))) {
            NamedTag root = input.readNamedTag();
            CompoundTag schematic = (CompoundTag) root.getTag();
            Map<String, Tag> values = schematic.getValue();
            byte[] blocks = (byte[]) values.get("Blocks").getValue();
            byte[] data = (byte[]) values.get("Data").getValue();
            int hash = 0;
            long nonAir = 0;
            for (int i = 0; i < blocks.length; i++) {
                hash = hash * 31 + (((blocks[i] & 0xff) << 4) | (data[i] & 0xff));
                if (blocks[i] != 0) nonAir++;
            }
            System.out.println("{\"file\":" + quote(path)
                + ",\"root\":" + quote(root.getName())
                + ",\"size\":[" + values.get("Width").getValue() + "," + values.get("Height").getValue() + "," + values.get("Length").getValue() + "]"
                + ",\"materials\":" + quote((String) values.get("Materials").getValue())
                + ",\"blocks\":" + blocks.length
                + ",\"hash\":" + hash
                + ",\"nonAir\":" + nonAir
                + ",\"tiles\":" + ((Iterable<?>) values.get("TileEntities").getValue()).spliterator().getExactSizeIfKnown()
                + ",\"entities\":" + ((Iterable<?>) values.get("Entities").getValue()).spliterator().getExactSizeIfKnown()
                + "}");
        }
    }
}
