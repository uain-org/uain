//go:build !orchard || !cgo

package privateexchange

func Available() bool                                         { return false }
func Effects([]byte) ([32]byte, error)                        { return [32]byte{}, ErrUnavailable }
func Verify([]byte, string, uint64, [32]byte) (Result, error) { return Result{}, ErrUnavailable }
func Combine(uint8, [32]byte, [32]byte) ([32]byte, error)     { return [32]byte{}, ErrUnavailable }
func Empty(uint8) ([32]byte, error)                           { return [32]byte{}, ErrUnavailable }
