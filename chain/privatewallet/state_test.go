package privatewallet

import (
	"bytes"
	"google.golang.org/protobuf/encoding/protowire"
	"testing"
)

func pageRow(key, value []byte) []byte {
	row := protowire.AppendTag(nil, 1, protowire.BytesType)
	row = protowire.AppendBytes(row, key)
	row = protowire.AppendTag(row, 2, protowire.BytesType)
	row = protowire.AppendBytes(row, value)
	out := protowire.AppendTag(nil, 1, protowire.BytesType)
	return protowire.AppendBytes(out, row)
}
func TestNotePageRefusesMalformedDuplicateAndUnboundedTransport(t *testing.T) {
	value := append([]byte{'"'}, bytes.Repeat([]byte{'0'}, 64)...)
	value = append(value, '"')
	good := pageRow([]byte("private_note/0000000000"), value)
	if rows, err := decodePage(good); err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
	for _, bad := range [][]byte{good[:len(good)-1], append(bytes.Clone(good), good...), bytes.Repeat([]byte{0}, 256*1024+1), []byte{0x08, 0x01}, pageRow([]byte("private_note/0000000000"), []byte("unbounded noncanonical field"))} {
		if _, err := decodePage(bad); err == nil {
			t.Fatal("malformed page accepted")
		}
	}
}
